/**
 * Conversation log.
 *
 * Exists because a reply could previously be lost for good: her ambient
 * muttering replaced the bubble *and* the remembered text, so a long answer
 * that scrolled past was simply gone.
 *
 * Transcripts are plain text on purpose -- the model's Markdown is shown as
 * written rather than rendered, so code blocks keep their original spacing.
 */

const api = window.deskpet;

const log = document.getElementById('log');
const summary = document.getElementById('summary');
const status = document.getElementById('status');

function render(history) {
  log.replaceChildren();

  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有对话记录。和她说点什么吧。';
    log.append(empty);
    summary.textContent = '暂无记录';
    return;
  }

  const turns = history.filter((m) => m.role === 'user').length;
  summary.textContent = `${turns} 轮对话 · 共 ${history.length} 条消息`;

  for (const item of history) {
    const turn = document.createElement('div');
    turn.className = `turn ${item.role === 'user' ? 'user' : 'pet'}`;

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = item.role === 'user' ? '你' : '茜特菈莉';

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = item.content;

    turn.append(who, body);
    log.append(turn);
  }

  // Newest at the bottom, which is where the reader wants to be.
  log.scrollTop = log.scrollHeight;
}

async function refresh() {
  try {
    render(await api.getHistory());
  } catch (err) {
    status.textContent = `读取失败：${err.message}`;
  }
}

document.getElementById('refresh').addEventListener('click', refresh);

document.getElementById('clear').addEventListener('click', async () => {
  await api.clearHistory();
  await refresh();
  status.textContent = '已清空。';
});

document.getElementById('close').addEventListener('click', () => window.close());

api.onChatDone(() => refresh());

refresh();
