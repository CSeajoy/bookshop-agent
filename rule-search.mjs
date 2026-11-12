const tokens = text => text.toLowerCase().match(/[a-z0-9_-]+|[\u4e00-\u9fff]/g) || [];
const isChinese = token => /^[\u4e00-\u9fff]$/.test(token);

function vector(text) {
  const words = tokens(text);
  const counts = Object.create(null);
  for (const [index, word] of words.entries()) {
    counts[word] = (counts[word] || 0) + 1;
    const next = words[index + 1];
    if (next && isChinese(word) && isChinese(next)) {
      const pair = word + next;
      counts[pair] = (counts[pair] || 0) + 1;
    }
  }
  return counts;
}

export function indexDocument(source, text) {
  const chunks = [];
  for (let start = 0; start < text.length; start += 380) {
    const content = text.slice(start, start + 500);
    chunks.push({ source, chunk: chunks.length + 1, content, vector: vector(content) });
  }
  return chunks;
}

export function matchRules(query, chunks) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) {
    throw new Error('规则查询须为1至300字');
  }
  const counts = vector(query);
  const magnitude = Math.hypot(...Object.values(counts));
  return chunks.map(chunk => {
    let dot = 0;
    for (const [term, count] of Object.entries(counts)) {
      dot += count * (chunk.vector[term] || 0);
    }
    const scale = magnitude * Math.hypot(...Object.values(chunk.vector)) || 1;
    return { source: chunk.source, chunk: chunk.chunk, excerpt: chunk.content, score: dot / scale };
  }).filter(match => match.score >= 0.06).sort((a, b) => b.score - a.score).slice(0, 3);
}
