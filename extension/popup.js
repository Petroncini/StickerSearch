const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await browser.runtime.sendMessage({ type: 'status' });
  const label = { idle: 'not loaded yet', loading: `downloading ${Math.round(s.progress * 100)}%`, ready: 'ready', error: 'failed to load' };
  $('model').textContent = 'Model: ' + (label[s.state] || s.state);
  $('count').textContent = `${s.indexed} stickers indexed` + (s.pending ? `, ${s.pending} in queue` : '');
  $('err').textContent = s.error || '';
  $('load').style.display = s.state === 'ready' ? 'none' : '';
}

$('load').addEventListener('click', () => browser.runtime.sendMessage({ type: 'warmup' }).then(refresh));
$('clear').addEventListener('click', async () => {
  if (!confirm('Delete every indexed sticker? You can re-index from the sticker panel.')) return;
  await browser.runtime.sendMessage({ type: 'clear' });
  refresh();
});

refresh();
setInterval(refresh, 1000);
