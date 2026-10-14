// Example plugin: reject requests whose message text contains a blocked word.
// Enable by copying this file into ./plugins and setting POURGATE_BLOCK_WORDS=word1,word2
const words = (process.env.POURGATE_BLOCK_WORDS ?? '')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p?.type === 'text' ? p.text : '')).join(' ')
      : '';

export default {
  name: 'block-words',
  onRequest({ endpoint, body }) {
    if (endpoint !== 'chat' || words.length === 0) return;
    const text = (body.messages ?? []).map((m) => textOf(m?.content)).join(' ').toLowerCase();
    const hit = words.find((w) => text.includes(w));
    if (hit) return { reject: { status: 400, message: 'This request contains a blocked term.' } };
  },
};
