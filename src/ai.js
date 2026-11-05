import { config } from './config.js';

export async function analyzeCall({ transcript, customerNumber, duration, availableDispositions = [] }) {
  if (config.ai.provider === 'none' || !transcript) {
    return null;
  }

  const prompt = `You are an AI Contact Center Assistant for ACW (After-Call Work).
Analyze the following phone call transcript and return a JSON object with:
1. "summary": A concise, executive 2-sentence summary of the customer's issue and resolution.
2. "action_items": An array of bullet-point follow-up action items (if any).
3. "suggested_disposition": Best matching outcome from the available list: ${JSON.stringify(availableDispositions)}.
4. "sentiment": One of "positive", "neutral", "frustrated", "urgent".

Transcript:
"""
${transcript.slice(0, 4000)}
"""

Respond ONLY with valid JSON.`;

  try {
    if (config.ai.provider === 'openai') {
      if (!config.ai.apiKey) return null;
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ai.apiKey}`,
        },
        body: JSON.stringify({
          model: config.ai.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) throw new Error(`OpenAI error status ${res.status}`);
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    }

    if (config.ai.provider === 'ollama') {
      const res = await fetch(`${config.ai.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ai.model || 'llama3.2',
          prompt,
          format: 'json',
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) throw new Error(`Ollama error status ${res.status}`);
      const data = await res.json();
      return JSON.parse(data.response);
    }
  } catch (err) {
    console.warn('[ai] call analysis failed:', err.message);
    return null;
  }

  return null;
}
