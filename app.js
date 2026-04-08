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
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_TOKEN = process.env.APPS_SCRIPT_TOKEN;

// ─── Запросы к Google Apps Script ────────────────────────────────────────────
async function sheetsRequest(payload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, token: APPS_SCRIPT_TOKEN }),
    redirect: "follow",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apps Script error: ${res.status} ${text}`);
  }

  return res.json();
}

async function insertRow(data) {
  return sheetsRequest({ action: "insert", ...data });
}

async function updateDecision(row, approverName, status, reason = "") {
  return sheetsRequest({
    action: "update_decision",
    row,
    approverName,
    status,
    reason,
  });
}

// ─── Загрузка отделов из файла ────────────────────────────────────────────────
function loadDepartments() {
  const filePath = path.join(__dirname, "departments.txt");
  const content = fs.readFileSync(filePath, "utf-8");

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// ─── Хелперы ─────────────────────────────────────────────────────────────────
function formatDate(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

function calcInclusiveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  return Math.floor((end - start) / 86400000) + 1;
}

async function getUserDisplayName(client, userId) {
  const res = await client.users.info({ user: userId });
  return res.user?.real_name || res.user?.profile?.real_name || res.user?.name || userId;
}

async function getSlackPermalink(client, channel, ts) {
  const res = await client.chat.getPermalink({ channel, message_ts: ts });
  return res.permalink;
}

async function publishHome(userId, client) {
  await client.views.publish({
    user_id: userId,
    view: {
      type: "home",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "Заявки на отпуск / Day-off",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "Нажмите кнопку ниже, чтобы отправить заявку на *Отпуск* или *Day-off*.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "open_vacation_modal",
              text: {
                type: "plain_text",
                text: "🌴 Хочу в отпуск",
                emoji: true,
              },
              style: "primary",
            },
          ],
        },
      ],
    },
  });
}

async function openVacationModal(trigger_id, client) {
  const departments = loadDepartments();

  const deptOptions = departments.map((d) => ({
    text: { type: "plain_text", text: d, emoji: false },
    value: d,
  }));

  await client.views.open({
    trigger_id,
    view: {
      type: "modal",
      callback_id: "vacation_form_submit",
      title: { type: "plain_text", text: "Заявка на отпуск" },
      submit: { type: "plain_text", text: "Отправить" },
      close: { type: "plain_text", text: "Отмена" },
      private_metadata: JSON.stringify({
        channel: VACATION_CHANNEL_ID,
      }),
      blocks: [
        {
          type: "input",
          block_id: "type_block",
          label: { type: "plain_text", text: "Тип" },
          element: {
            type: "static_select",
            action_id: "vacation_type",
            placeholder: { type: "plain_text", text: "Выберите тип" },
            options: [
              {
                text: { type: "plain_text", text: "Отпуск" },
                value: "Отпуск",
              },
              {
                text: { type: "plain_text", text: "Day-off" },
                value: "Day-off",
              },
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
            placeholder: { type: "plain_text", text: "Выберите отдел" },
            options: deptOptions,
          },
        },
        {
          type: "input",
          block_id: "manager_block",
          label: { type: "plain_text", text: "Ваш согласующий руководитель" },
          element: {
            type: "users_select",
            action_id: "manager",
            placeholder: { type: "plain_text", text: "Выберите руководителя" },
          },
        },
        {
          type: "input",
          block_id: "start_date_block",
          label: { type: "plain_text", text: "Дата начала отпуска" },
          element: {
            type: "datepicker",
            action_id: "start_date",
            placeholder: { type: "plain_text", text: "Выберите дату" },
          },
        },
        {
          type: "input",
          block_id: "end_date_block",
          label: { type: "plain_text", text: "Дата окончания отпуска" },
          element: {
            type: "datepicker",
            action_id: "end_date",
            placeholder: { type: "plain_text", text: "Выберите дату" },
          },
        },
        {
          type: "input",
          block_id: "vrio_block",
          label: { type: "plain_text", text: "ВРИО на время отсутствия" },
          element: {
            type: "users_select",
            action_id: "vrio",
            placeholder: { type: "plain_text", text: "Выберите сотрудника" },
          },
        },
        {
          type: "input",
          block_id: "notify_block",
          optional: true,
          label: { type: "plain_text", text: "Кого из коллег нужно предупредить" },
          element: {
            type: "multi_users_select",
            action_id: "notify_users",
            placeholder: { type: "plain_text", text: "Выберите коллег" },
          },
        },
      ],
    },
  });
}

// ─── App Home ────────────────────────────────────────────────────────────────
app.event("app_home_opened", async ({ event, client, logger }) => {
  try {
    await publishHome(event.user, client);
  } catch (error) {
    logger.error(error);
  }
});

// ─── Открытие модалки ────────────────────────────────────────────────────────
app.action("open_vacation_modal", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    await openVacationModal(body.trigger_id, client);
  } catch (error) {
    logger.error(error);
  }
});

// ─── Отправка формы ───────────────────────────────────────────────────────────
app.view("vacation_form_submit", async ({ ack, body, view, client, logger }) => {
  try {
    const v = view.state.values;

    const vacationType =
      v.type_block.vacation_type.selected_option.value;
    const department =
      v.department_block.department.selected_option.value;
    const managerId =
      v.manager_block.manager.selected_user;
    const startDate =
      v.start_date_block.start_date.selected_date;
    const endDate =
      v.end_date_block.end_date.selected_date;
    const vrioId =
      v.vrio_block.vrio.selected_user;
    const notifyUsers =
      v.notify_block.notify_users.selected_users || [];
    const employeeId = body.user.id;

    if (!startDate || !endDate) {
      await ack({
        response_action: "errors",
        errors: {
          start_date_block: "Укажите дату начала",
          end_date_block: "Укажите дату окончания",
        },
      });
      return;
    }

    if (endDate < startDate) {
      await ack({
        response_action: "errors",
        errors: {
          end_date_block: "Дата окончания не может быть раньше даты начала",
        },
      });
      return;
    }

    const daysCount = calcInclusiveDays(startDate, endDate);

    await ack();

    const meta = JSON.parse(view.private_metadata);
    const channel = meta.channel || VACATION_CHANNEL_ID;

    const [
      employeeName,
      managerName,
      vrioName,
    ] = await Promise.all([
      getUserDisplayName(client, employeeId),
      getUserDisplayName(client, managerId),
      getUserDisplayName(client, vrioId),
    ]);

    // Главное сообщение в канале
    const mainMsg = await client.chat.postMessage({
      channel,
      text: `На ${daysCount} дней: с ${formatDate(startDate)} по ${formatDate(endDate)} от ${employeeName} из ${department}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `На *${daysCount} дней*: с *${formatDate(startDate)}* по *${formatDate(endDate)}* ` +
              `от <@${employeeId}> из *${department}*`,
          },
        },
      ],
    });

    // Реакция "ждун"
    await client.reactions.add({
      channel,
      timestamp: mainMsg.ts,
      name: "hourglass_flowing_sand",
    });

    const threadUrl = await getSlackPermalink(client, channel, mainMsg.ts);
    const applicationDate = new Date().toISOString().slice(0, 10);

    // Запись в таблицу сразу после submit
    // Apps Script должен уметь принять эти поля и записать:
    // Тип, Сотрудник, Отдел, С, По, Кол-во дней, Дата заявки, ВРИО, Статус, Кто согласовал/отклонил, Причина
    const insertResult = await insertRow({
      threadUrl,
      applicationDate,
      employeeId,
      employeeName,
      department,
      managerId,
      managerName,
      vacationType,
      startDate,
      endDate,
      daysCount,
      vrioId,
      vrioName,
      notifyUsers,
      status: "На рассмотрении",
      approverName: "",
      reason: "",
    });

    const rowNum = insertResult.row;

    // Сообщение в треде с кнопками
    await client.chat.postMessage({
      channel,
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
          block_id: "approval_actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "✅ Согласовать", emoji: true },
              style: "primary",
              action_id: "approve_vacation",
              value: JSON.stringify({
                rowNum,
                channel,
                threadTs: mainMsg.ts,
                mainMsgTs: mainMsg.ts,
                employeeId,
                employeeName,
                managerId,
                managerName,
                vacationType,
                department,
                startDate,
                endDate,
                daysCount,
                vrioId,
                vrioName,
                notifyUsers,
              }),
            },
            {
              type: "button",
              text: { type: "plain_text", text: "❌ Отклонить", emoji: true },
              style: "danger",
              action_id: "reject_vacation",
              value: JSON.stringify({
                rowNum,
                channel,
                threadTs: mainMsg.ts,
                mainMsgTs: mainMsg.ts,
                employeeId,
                employeeName,
                managerId,
                managerName,
                vacationType,
                department,
                startDate,
                endDate,
                daysCount,
                vrioId,
                vrioName,
                notifyUsers,
              }),
            },
          ],
        },
      ],
    });
  } catch (error) {
    logger.error(error);
  }
});

// ─── Согласование ─────────────────────────────────────────────────────────────
app.action("approve_vacation", async ({ ack, body, action, client, logger }) => {
  await ack();

  try {
    const data = JSON.parse(action.value);
    const actorId = body.user.id;

    if (actorId !== data.managerId) {
      await client.chat.postEphemeral({
        channel: data.channel,
        user: actorId,
        text: "⚠️ Только руководитель, указанный в заявке, может её согласовать.",
      });
      return;
    }

    const approverName = await getUserDisplayName(client, actorId);

    await updateDecision(data.rowNum, approverName, "Согласована", "");

    // Убираем кнопки, оставляем итоговый статус
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
              `*Тип:* ${data.vacationType}\n` +
              `*ВРИО:* <@${data.vrioId}>\n\n` +
              `<@${actorId}> согласовал(а) Ваш отпуск! ✅`,
          },
        },
      ],
    });

    // Сообщение для коллег
    const notifyMentions = (data.notifyUsers || [])
      .map((uid) => `<@${uid}>`)
      .join(", ");

    const notifyText =
      `${notifyMentions ? `${notifyMentions}, ` : ""}` +
      `с *${formatDate(data.startDate)}* по *${formatDate(data.endDate)}* ` +
      `в течение *${data.daysCount} дней* вместо <@${data.employeeId}> ` +
      `его/её обязанности будет исполнять <@${data.vrioId}>.\n\n` +
      `<@${data.employeeId}>, отлично вам отдохнуть! 🌴`;

    await client.chat.postMessage({
      channel: data.channel,
      thread_ts: data.threadTs,
      text: notifyText,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: notifyText },
        },
      ],
    });

    // Меняем реакции
    try {
      await client.reactions.remove({
        channel: data.channel,
        timestamp: data.mainMsgTs,
        name: "hourglass_flowing_sand",
      });
    } catch (_) {}

    await client.reactions.add({
      channel: data.channel,
      timestamp: data.mainMsgTs,
      name: "white_check_mark",
    });

    await client.reactions.add({
      channel: data.channel,
      timestamp: data.mainMsgTs,
      name: "palm_tree",
    });
  } catch (error) {
    logger.error(error);
  }
});

// ─── Отклонение: открытие модалки ────────────────────────────────────────────
app.action("reject_vacation", async ({ ack, body, action, client, logger }) => {
  await ack();

  try {
    const data = JSON.parse(action.value);
    const actorId = body.user.id;

    if (actorId !== data.managerId && actorId !== data.employeeId) {
      await client.chat.postEphemeral({
        channel: data.channel,
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
              placeholder: { type: "plain_text", text: "Укажите причину..." },
            },
          },
        ],
      },
    });
  } catch (error) {
    logger.error(error);
  }
});

// ─── Отклонение: submit причины ──────────────────────────────────────────────
app.view("reject_reason_submit", async ({ ack, view, client, logger }) => {
  await ack();

  try {
    const meta = JSON.parse(view.private_metadata);
    const reason = view.state.values.reason_block.reason.value;
    const actorId = meta.actorId;

    const actorName = await getUserDisplayName(client, actorId);

    await updateDecision(meta.rowNum, actorName, "Отклонена", reason || "");

    await client.chat.update({
      channel: meta.channel,
      ts: meta.buttonMsgTs,
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

    try {
      await client.reactions.remove({
        channel: meta.channel,
        timestamp: meta.mainMsgTs,
        name: "hourglass_flowing_sand",
      });
    } catch (_) {}

    await client.reactions.add({
      channel: meta.channel,
      timestamp: meta.mainMsgTs,
      name: "x",
    });
  } catch (error) {
    logger.error(error);
  }
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log("⚡ Vacation Bot запущен!");
})();
