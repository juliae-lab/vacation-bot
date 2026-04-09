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
const APPS_SCRIPT_URL     = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_TOKEN   = process.env.APPS_SCRIPT_TOKEN;

// ─── Google Apps Script ───────────────────────────────────────────────────────
async function sheetsRequest(payload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, token: APPS_SCRIPT_TOKEN }),
    redirect: "follow",
  });
  return res.json();
}

const insertRow     = (data)                       => sheetsRequest({ action: "insert", ...data });
const updateStatus  = (row, approverName, status)  => sheetsRequest({ action: "update_status", row, approverName, status });
const getDays       = async (row) => { const r = await sheetsRequest({ action: "get_days", row }); return r.days ?? "?"; };

// ─── Загрузка отделов ─────────────────────────────────────────────────────────
function loadDepartments() {
  return fs.readFileSync(path.join(__dirname, "departments.txt"), "utf-8")
    .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

// ─── Список пользователей воркспейса ─────────────────────────────────────────
async function getWorkspaceUsers(client) {
  let users = [], cursor;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    users = users.concat(res.members.filter(u => !u.is_bot && !u.deleted && u.id !== "USLACKBOT"));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return users;
}

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// ─── Webhook от Workflow ──────────────────────────────────────────────────────
// Workflow присылает данные формы сюда через "Send a webhook" step
const { createServer } = require("http");

const webhookServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/workflow") {
    res.writeHead(404); res.end(); return;
  }

  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", async () => {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      const payload = JSON.parse(body);
      // Workflow присылает: employee_id, vacation_type, department,
      // manager_id, start_date, end_date, vrio_id, notify_ids (через запятую)
      await handleWorkflowSubmit(payload);
    } catch (e) {
      console.error("Webhook error:", e);
    }
  });
});

webhookServer.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Webhook сервер слушает на порту", process.env.PORT || 3000);
});

// ─── Обработка данных из Workflow ─────────────────────────────────────────────
async function handleWorkflowSubmit(payload) {
  const {
    employee_id,
    vacation_type,
    department,
    manager_id,
    start_date,
    end_date,
    vrio_id,
    notify_ids, // строка "U123,U456"
  } = payload;

  const notifyUsers = notify_ids ? notify_ids.split(",").map(s => s.trim()).filter(Boolean) : [];

  // Получаем имена
  const [empInfo, vrioInfo] = await Promise.all([
    app.client.users.info({ user: employee_id }),
    app.client.users.info({ user: vrio_id }),
  ]);
  const employeeName = empInfo.user.real_name  || empInfo.user.name;
  const vrioName     = vrioInfo.user.real_name || vrioInfo.user.name;

  const daysCount = Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1;

  // Главное сообщение в канал
  const mainMsg = await app.client.chat.postMessage({
    channel: VACATION_CHANNEL_ID,
    text: `На ${daysCount} дней: с ${formatDate(start_date)} по ${formatDate(end_date)} от ${employeeName} из ${department}`,
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `На *${daysCount} дней*: с *${formatDate(start_date)}* по *${formatDate(end_date)}* от <@${employee_id}> из ${department}`,
      },
    }],
  });

  // Реакция ⏳
  await app.client.reactions.add({
    channel: VACATION_CHANNEL_ID,
    timestamp: mainMsg.ts,
    name: "hourglass_flowing_sand",
  });

  // Ссылка на тред
  const teamInfo = await app.client.team.info();
  const threadUrl = `https://${teamInfo.team.domain}.slack.com/archives/${VACATION_CHANNEL_ID}/p${mainMsg.ts.replace(".", "")}`;

  // Пишем в таблицу
  const insertResult = await insertRow({ threadUrl, employeeName, vacationType: vacation_type, startDate: start_date, endDate: end_date, vrioName });
  const rowNum = insertResult.row;

  // Ждём пересчёта формулы
  await new Promise(r => setTimeout(r, 2000));
  const daysFromSheet = await getDays(rowNum);

  // Тред с деталями и кнопками
  await app.client.chat.postMessage({
    channel: VACATION_CHANNEL_ID,
    thread_ts: mainMsg.ts,
    text: "Заявка на согласование",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Тип:* ${vacation_type}\n` +
            `*ВРИО:* <@${vrio_id}>\n\n` +
            `<@${manager_id}>, прошу согласовать или отклонить заявку, указав причину.`,
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
              employeeId: employee_id,
              employeeName,
              managerId: manager_id,
              vrioId: vrio_id,
              vrioName,
              notifyUsers,
              startDate: start_date,
              endDate: end_date,
              daysCount: daysFromSheet,
              mainMsgTs: mainMsg.ts,
              channel: VACATION_CHANNEL_ID,
              rowNum,
              vacationType: vacation_type,
            }),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Отклонить", emoji: true },
            style: "danger",
            action_id: "reject_vacation",
            value: JSON.stringify({
              employeeId: employee_id,
              managerId: manager_id,
              startDate: start_date,
              endDate: end_date,
              mainMsgTs: mainMsg.ts,
              channel: VACATION_CHANNEL_ID,
              rowNum,
            }),
          },
        ],
      },
    ],
  });
}

// ─── Согласование ─────────────────────────────────────────────────────────────
app.action("approve_vacation", async ({ ack, body, action, client }) => {
  await ack();
  const data = JSON.parse(action.value);
  const actorId = body.user.id;

  if (actorId !== data.managerId) {
    await client.chat.postEphemeral({
      channel: data.channel, thread_ts: body.message.ts, user: actorId,
      text: "⚠️ Только руководитель, указанный в заявке, может её согласовать.",
    });
    return;
  }

  const actorInfo = await client.users.info({ user: actorId });
  const approverName = actorInfo.user.real_name || actorInfo.user.name;

  await updateStatus(data.rowNum, approverName, "Согласована");

  await client.chat.update({
    channel: data.channel, ts: body.message.ts, text: "Заявка согласована",
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `*Тип:* ${data.vacationType || ""}\n*ВРИО:* <@${data.vrioId}>\n\n<@${actorId}> согласовал(а) заявку ✅` },
    }],
  });

  await client.chat.postMessage({
    channel: data.channel,
    thread_ts: body.message.thread_ts || body.message.ts,
    text: `<@${actorId}> согласовал(а) Ваш отпуск! 🎉`,
  });

  const notifyMentions = (data.notifyUsers || []).map(uid => `<@${uid}>`).join(", ");
  const notifyText =
    `${notifyMentions ? notifyMentions + ", обратите внимание: " : ""}` +
    `с *${formatDate(data.startDate)}* по *${formatDate(data.endDate)}* ` +
    `в течение *${data.daysCount} дней* вместо <@${data.employeeId}> ` +
    `его/её обязанности будет исполнять <@${data.vrioId}>.\n\n` +
    `<@${data.employeeId}>, отлично вам отдохнуть! 🌴`;

  await client.chat.postMessage({
    channel: data.channel,
    thread_ts: body.message.thread_ts || body.message.ts,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: notifyText } }],
    text: notifyText,
  });

  try { await client.reactions.remove({ channel: data.channel, timestamp: data.mainMsgTs, name: "hourglass_flowing_sand" }); } catch (_) {}
  await client.reactions.add({ channel: data.channel, timestamp: data.mainMsgTs, name: "white_check_mark" });
  await client.reactions.add({ channel: data.channel, timestamp: data.mainMsgTs, name: "palm_tree" });
});

// ─── Отклонение шаг 1 — модалка с причиной ───────────────────────────────────
app.action("reject_vacation", async ({ ack, body, action, client }) => {
  await ack();
  const data = JSON.parse(action.value);
  const actorId = body.user.id;

  if (actorId !== data.managerId && actorId !== data.employeeId) {
    await client.chat.postEphemeral({
      channel: data.channel, thread_ts: body.message.ts, user: actorId,
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
        ...data, actorId,
        threadTs: body.message.thread_ts || body.message.ts,
        buttonMsgTs: body.message.ts,
      }),
      blocks: [{
        type: "input", block_id: "reason_block",
        label: { type: "plain_text", text: "Причина отклонения" },
        element: {
          type: "plain_text_input", action_id: "reason", multiline: true,
          placeholder: { type: "plain_text", text: "Укажи причину..." },
        },
      }],
    },
  });
});

// ─── Отклонение шаг 2 — применить ────────────────────────────────────────────
app.view("reject_reason_submit", async ({ ack, body, view, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);
  const reason = view.state.values.reason_block.reason.value;

  const actorInfo = await client.users.info({ user: meta.actorId });
  const actorName = actorInfo.user.real_name || actorInfo.user.name;

  await updateStatus(meta.rowNum, actorName, "Отклонена");

  await client.chat.update({
    channel: meta.channel, ts: meta.buttonMsgTs, text: "Заявка отклонена",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `<@${meta.actorId}> отклонил(а) заявку ❌` } }],
  });

  await client.chat.postMessage({
    channel: meta.channel, thread_ts: meta.threadTs,
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `<@${meta.actorId}> отклонил(а) Ваш запрос! ❌\n\n*Причина:* ${reason}` },
    }],
    text: `Заявка отклонена. Причина: ${reason}`,
  });

  try { await client.reactions.remove({ channel: meta.channel, timestamp: meta.mainMsgTs, name: "hourglass_flowing_sand" }); } catch (_) {}
  await client.reactions.add({ channel: meta.channel, timestamp: meta.mainMsgTs, name: "x" });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log("⚡ Vacation Bot запущен!");
})();
