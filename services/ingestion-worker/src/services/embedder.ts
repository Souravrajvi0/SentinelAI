import OpenAI from 'openai';

interface EmbedderConfig {
  apiKey: string;
  model: string;
}

// Mistral embeddings use the OpenAI-compatible SDK with a custom base URL
export class Embedder {
  private client: OpenAI;
  private model: string;

  constructor(cfg: EmbedderConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: 'https://api.mistral.ai/v1',
    });
    this.model = cfg.model;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    return res.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  async embedOne(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    if (!embedding) throw new Error('Embedding returned empty result');
    return embedding;
  }
}
