export interface ChunkOptions {
  maxTokens?: number;   // ~words × 1.3
  overlap?: number;     // overlap in tokens between adjacent chunks
}

// Token-approximate chunker: splits on sentences, respects maxTokens budget.
// Real production version would use tiktoken for exact counts.
export function chunkText(
  text: string,
  opts: ChunkOptions = {}
): Array<{ content: string; chunk_index: number; token_estimate: number }> {
  const maxTokens = opts.maxTokens ?? 512;
  const overlap = opts.overlap ?? 64;

  // Sentence split — handles . ! ? followed by whitespace
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: Array<{ content: string; chunk_index: number; token_estimate: number }> = [];
  let current: string[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  const approxTokens = (s: string) => Math.ceil(s.length / 4);

  for (const sentence of sentences) {
    const t = approxTokens(sentence);

    if (currentTokens + t > maxTokens && current.length > 0) {
      const content = current.join(' ');
      chunks.push({ content, chunk_index: chunkIndex++, token_estimate: currentTokens });

      // Overlap: keep last N tokens worth of sentences
      let keepTokens = 0;
      const keep: string[] = [];
      for (let i = current.length - 1; i >= 0; i--) {
        const st = approxTokens(current[i]!);
        if (keepTokens + st > overlap) break;
        keep.unshift(current[i]!);
        keepTokens += st;
      }
      current = keep;
      currentTokens = keepTokens;
    }

    current.push(sentence);
    currentTokens += t;
  }

  if (current.length > 0) {
    chunks.push({
      content: current.join(' '),
      chunk_index: chunkIndex,
      token_estimate: currentTokens,
    });
  }

  return chunks;
}
