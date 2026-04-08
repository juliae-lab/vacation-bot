const { App } = require("@slack/bolt");
const fs = require("fs");
const path = require("path");

// ─── Инициализация ────────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const VACATION_CHANNEL_ID = process.env.VACATION_CHANNEL_ID;
const APPS_SCRIPT_URL     = process.env.APPS_SCRIPT_URL;     // URL из Google Apps Script
const APPS_SCRIPT_TOKEN   = process.env.APPS_SCRIPT_TOKEN;   // секретный токен

// ─── Запросы к Google Apps Script ────────────────────────────────────────────
async function sheetsRequest(payload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, token: APPS_SCRIPT_TOKEN }),
    redirect: "follow",
  });
  return res.json();
}

async function insertRow(data) {
  return sheetsRequest({ action: "insert", ...data });
}

async function updateStatus(row, approverName, status) {
  return sheetsRequest({ action: "update_status", row, approverName, status });
}

async function getDays(row) {
  const res = await sheetsRequest({ action: "get_days", row });
  return res.days ?? "?";
}

// ─── Загрузка отделов из файла ────────────────────────────────────────────────
function loadDepartments() {
  const filePath = path.join(__dirname, "departments.txt");
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// ─── Список пользователей воркспейса ─────────────────────────────────────────
async function getWorkspaceUsers(client) {
  let users = [];
  let cursor;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    users = users.concat(
      res.members.filter((u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT")
    );
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return users;
}

// ─── Опубликовать кнопку в канал (один раз) ──────────────────────────────────
async function postVacationButton() {
  await app.client.chat.postMessage({
    channel: VACATION_CHANNEL_ID,
    text: "Хочешь в отпуск? Нажми кнопку ниже 👇",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*🏖 Заявка на отпуск / Day-off*\nНажми кнопку, чтобы подать заявку.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🌴 Хочу в отпуск", emoji: true },
            style: "primary",
            action_id: "open_vacation_modal",
          },
        ],
      },
    ],
  });
}

// ─── Открыть модальную форму ──────────────────────────────────────────────────
app.action("open_vacation_modal", async ({ body, ack, client }) => {
  await ack();

  const departments = loadDepartments();
  const users = await getWorkspaceUsers(client);

  const userOptions = users.map((u) => ({
    text: { type: "plain_text", text: u.real_name || u.name, emoji: false },
    value: u.id,
  }));

  const deptOptions = departments.map((d) => ({
    text: { type: "plain_text", text: d, emoji: false },
    value: d,
  }));

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "vacation_form_submit",
      title: { type: "plain_text", text: "Заявка на отпуск" },
      submit: { type: "plain_text", text: "Отправить" },
      close: { type: "plain_text", text: "Отмена" },
      private_metadata: JSON.stringify({
        channel: body.channel.id,
        message_ts: body.message.ts,
      }),
      blocks: [
        {
          type: "input",
          block_id: "type_block",
          label: { type: "plain_text", text: "Тип" },
          element: {
            type: "static_select",
            action_id: "vacation_type",
            placeholder: { type: "plain_text", text: "Выбери тип" },
            options: [
              { text: { type: "plain_text", text: "Отпуск" }, value: "Отпуск" },
              { text: { type: "plain_text", text: "Day-off" }, value: "Day-off" },
            ],
          },
        },
        {
          type: "input",
          block_id: "department_block",
          label: { type: "plain_text", text: "Ваш отдел" },
          element: {
            type: "static_select",
            action_id: "department",
            placeholder: { type: "plain_text", text: "Выбери отдел" },
            options: deptOptions,
          },
        },
        {
          type: "input",
          block_id: "manager_block",
          label: { type: "plain_text", text: "Ваш согласующий руководитель" },
          element: {
            type: "static_select",
            action_id: "manager",
            placeholder: { type: "plain_text", text: "Выбери руководителя" },
            options: userOptions,
          },
        },
        {
          type: "input",
          block_id: "start_date_block",
          label: { type: "plain_text", text: "Дата начала отпуска" },
          element: {
            type: "datepicker",
            action_id: "start_date",
            placeholder: { type: "plain_text", text: "Выбери дату" },
          },
        },
        {
          type: "input",
          block_id: "end_date_block",
          label: { type: "plain_text", text: "Дата окончания отпуска" },
          element: {
            type: "datepicker",
            action_id: "end_date",
            placeholder: { type: "plain_text", text: "Выбери дату" },
          },
        },
        {
          type: "input",
          block_id: "vrio_block",
          label: { type: "plain_text", text: "ВРИО на время отсутствия" },
          element: {
            type: "static_select",
            action_id: "vrio",
            placeholder: { type: "plain_text", text: "Выбери сотрудника" },
            options: userOptions,
          },
        },
        {
          type: "input",
          block_id: "notify_block",
          label: { type: "plain_text", text: "Кого из коллег нужно предупредить" },
          element: {
            type: "multi_static_select",
            action_id: "notify_users",
            placeholder: { type: "plain_text", text: "Выбери коллег" },
            options: userOptions,
          },
        },
      ],
    },
  });
});

// ─── Отправка формы ───────────────────────────────────────────────────────────
app.view("vacation_form_submit", async ({ ack, body, view, client }) => {
  await ack();

  const v    = view.state.values;
  const meta = JSON.parse(view.private_metadata);

  const vacationType = v.type_block.vacation_type.selected_option.value;
  const department   = v.department_block.department.selected_option.value;
  const managerId    = v.manager_block.manager.selected_option.value;
  const startDate    = v.start_date_block.start_date.selected_date;
  const endDate      = v.end_date_block.end_date.selected_date;
  const vrioId       = v.vrio_block.vrio.selected_option.value;
  const notifyUsers  = v.notify_block.notify_users.selected_options.map((o) => o.value);
  const employeeId   = body.user.id;

  const [employeeInfo, vrioInfo] = await Promise.all([
    client.users.info({ user: employeeId }),
    client.users.info({ user: vrioId }),
  ]);
  const employeeName = employeeInfo.user.real_name || employeeInfo.user.name;
  const vrioName     = vrioInfo.user.real_name     || vrioInfo.user.name;

  const daysCount = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;

  // Публикуем главное сообщение
  const mainMsg = await client.chat.postMessage({
    channel: meta.channel,
    text: `На ${daysCount} дней: с ${formatDate(startDate)} по ${formatDate(endDate)} от ${employeeName} из ${department}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `На *${daysCount} дней*: с *${formatDate(startDate)}* по *${formatDate(endDate)}* от <@${employeeId}> из ${department}`,
        },
      },
    ],
  });

  // Реакция ⏳
  await client.reactions.add({
    channel: meta.channel,
    timestamp: mainMsg.ts,
    name: "hourglass_flowing_sand",
  });

  // Ссылка на тред
  const teamInfo   = await client.team.info();
  const teamDomain = teamInfo.team.domain;
  const threadUrl  = `https://${teamDomain}.slack.com/archives/${meta.channel}/p${mainMsg.ts.replace(".", "")}`;

  // Записываем в таблицу
  const insertResult = await insertRow({
    threadUrl,
    employeeName,
    vacationType,
    startDate,
    endDate,
    vrioName,
  });
  const rowNum = insertResult.row;

  // Получаем кол-во дней из таблицы (формула уже посчиталась)
  await new Promise((r) => setTimeout(r, 1500)); // ждём пересчёт формулы
  const daysFromSheet = await getDays(rowNum);

  // Тред с деталями и кнопками
  await client.chat.postMessage({
    channel: meta.channel,
    thread_ts: mainMsg.ts,
    text: "Заявка на согласование",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Тип:* ${vacationType}\n` +
            `*ВРИО:* <@${vrioId}>\n\n` +
            `<@${managerId}>, прошу согласовать или отклонить заявку, указав причину.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Согласовать", emoji: true },
            style: "primary",
            action_id: "approve_vacation",
            value: JSON.stringify({
              employeeId,
              employeeName,
              managerId,
              vrioId,
              vrioName,
              notifyUsers,
              startDate,
              endDate,
              daysCount: daysFromSheet,
              mainMsgTs: mainMsg.ts,
              channel: meta.channel,
              rowNum,
            }),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Отклонить", emoji: true },
            style: "danger",
            action_id: "reject_vacation",
            value: JSON.stringify({
              employeeId,
              managerId,
              startDate,
              endDate,
              mainMsgTs: mainMsg.ts,
              channel: meta.channel,
              rowNum,
            }),
          },
        ],
      },
    ],
  });
});

// ─── Согласование ─────────────────────────────────────────────────────────────
app.action("approve_vacation", async ({ ack, body, action, client }) => {
  await ack();

  const data    = JSON.parse(action.value);
  const actorId = body.user.id;

  if (actorId !== data.managerId) {
    await client.chat.postEphemeral({
      channel: data.channel,
      thread_ts: body.message.ts,
      user: actorId,
      text: "⚠️ Только руководитель, указанный в заявке, может её согласовать.",
    });
    return;
  }

  const actorInfo   = await client.users.info({ user: actorId });
  const approverName = actorInfo.user.real_name || actorInfo.user.name;

  await updateStatus(data.rowNum, approverName, "Согласована");

  // Убираем кнопки
  await client.chat.update({
    channel: data.channel,
    ts: body.message.ts,
    text: "Заявка согласована",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Тип:* ${data.vacationType || ""}\n` +
            `*ВРИО:* <@${data.vrioId}>\n\n` +
            `<@${actorId}> согласовал(а) заявку ✅`,
        },
      },
    ],
  });

  // Сообщение об одобрении
  await client.chat.postMessage({
    channel: data.channel,
    thread_ts: body.message.thread_ts || body.message.ts,
    text: `<@${actorId}> согласовал(а) Ваш отпуск! 🎉`,
  });

  // Уведомление коллег
  const notifyMentions = (data.notifyUsers || []).map((uid) => `<@${uid}>`).join(", ");
  const notifyText =
    `${notifyMentions ? notifyMentions + ", " : ""}` +
    `с *${formatDate(data.startDate)}* по *${formatDate(data.endDate)}* ` +
    `в течение *${data.daysCount} дней* вместо <@${data.employeeId}> ` +
    `его/её обязанности будет исполнять <@${data.vrioId}>.\n\n` +
    `<@${data.employeeId}>, отлично вам отдохнуть! 🌴`;

  await client.chat.postMessage({
    channel: data.channel,
    thread_ts: body.message.thread_ts || body.message.ts,
    text: notifyText,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: notifyText } }],
  });

  // Меняем реакции
  try { await client.reactions.remove({ channel: data.channel, timestamp: data.mainMsgTs, name: "hourglass_flowing_sand" }); } catch (_) {}
  await client.reactions.add({ channel: data.channel, timestamp: data.mainMsgTs, name: "white_check_mark" });
  await client.reactions.add({ channel: data.channel, timestamp: data.mainMsgTs, name: "palm_tree" });
});

// ─── Отклонение — шаг 1: открыть модалку с причиной ─────────────────────────
app.action("reject_vacation", async ({ ack, body, action, client }) => {
  await ack();

  const data    = JSON.parse(action.value);
  const actorId = body.user.id;

  if (actorId !== data.managerId && actorId !== data.employeeId) {
    await client.chat.postEphemeral({
      channel: data.channel,
      thread_ts: body.message.ts,
      user: actorId,
      text: "⚠️ Отклонить заявку может только руководитель или сам заявитель.",
    });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "reject_reason_submit",
      title: { type: "plain_text", text: "Причина отклонения" },
      submit: { type: "plain_text", text: "Отправить" },
      close: { type: "plain_text", text: "Отмена" },
      private_metadata: JSON.stringify({
        ...data,
        actorId,
        threadTs:    body.message.thread_ts || body.message.ts,
        buttonMsgTs: body.message.ts,
      }),
      blocks: [
        {
          type: "input",
          block_id: "reason_block",
          label: { type: "plain_text", text: "Причина отклонения" },
          element: {
            type: "plain_text_input",
            action_id: "reason",
            multiline: true,
            placeholder: { type: "plain_text", text: "Укажи причину..." },
          },
        },
      ],
    },
  });
});

// ─── Отклонение — шаг 2: обработать причину ──────────────────────────────────
app.view("reject_reason_submit", async ({ ack, body, view, client }) => {
  await ack();

  const meta    = JSON.parse(view.private_metadata);
  const reason  = view.state.values.reason_block.reason.value;
  const actorId = meta.actorId;

  const actorInfo  = await client.users.info({ user: actorId });
  const actorName  = actorInfo.user.real_name || actorInfo.user.name;

  await updateStatus(meta.rowNum, actorName, "Отклонена");

  // Убираем кнопки
  await client.chat.update({
    channel: meta.channel,
    ts: meta.buttonMsgTs,
    text: "Заявка отклонена",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `<@${actorId}> отклонил(а) заявку ❌` },
      },
    ],
  });

  // Сообщение об отклонении
  await client.chat.postMessage({
    channel: meta.channel,
    thread_ts: meta.threadTs,
    text: "Заявка отклонена",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `<@${actorId}> отклонил(а) Ваш запрос! ❌\n\n` +
            `*Причина:* ${reason}`,
        },
      },
    ],
  });

  // Меняем реакции
  try { await client.reactions.remove({ channel: meta.channel, timestamp: meta.mainMsgTs, name: "hourglass_flowing_sand" }); } catch (_) {}
  await client.reactions.add({ channel: meta.channel, timestamp: meta.mainMsgTs, name: "x" });
});

// ─── Хелпер: форматирование даты ─────────────────────────────────────────────
function formatDate(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log("⚡ Vacation Bot запущен!");

  // Раскомментируй при первом запуске — опубликует кнопку в канал
  // await postVacationButton();
})();
