import type { VercelRequest, VercelResponse } from '@vercel/node';


interface TranslateRequestBody {
  model?: string;
  imageBase64: string;
  sourceLanguage: string;
  targetLanguage: string;
  notes?: string;
}

function extractTranslationValue(text: string): string | undefined {
  const keyMatch = /["']?translation["']?\s*:\s*/i.exec(text);
  if (!keyMatch) return undefined;

  const valueStart = keyMatch.index + keyMatch[0].length;
  if (text[valueStart] !== '"') return undefined;

  let value = '';
  let escaped = false;

  for (let index = valueStart + 1; index < text.length; index += 1) {
    const character = text[index];

    if (escaped) {
      value += `\\${character}`;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      try {
        return JSON.parse(`"${value}"`);
      } catch {
        return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      value += character;
    }
  }

  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageBase64, sourceLanguage, targetLanguage, notes } =
    req.body as TranslateRequestBody;


  // Lấy API key từ biến môi trường OPENROUTER_API_KEY
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: OPENROUTER_API_KEY is not set' });
  }

  if (!imageBase64) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

    

  try {

    // Lấy model từ biến môi trường OPENROUTER_MODEL, nếu không có thì dùng mặc định
    const model = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-super-vl:free';
    const sourceDesc = sourceLanguage === 'Auto Detect' ? 'ngôn ngữ được phát hiện' : sourceLanguage;

    const translationPrompt = [
      `Dịch đoạn văn bản trong hình ảnh từ ${sourceDesc} sang ${targetLanguage}.`,
      `Chỉ trả về bản dịch, không trả về text gốc.`,
      notes ? `Yêu cầu thêm: ${notes}` : '',
      `Trả về JSON: {"translation":"bản dịch ở đây"}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Gọi OpenRouter API
    const openrouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_REFERER || '', // optional, for OpenRouter analytics
        'X-Title': 'Gemini PDF Translator',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: translationPrompt },
              { type: 'image_url', image_url: `data:image/png;base64,${imageBase64}` },
            ],
          },
        ],
      }),
    });

    if (!openrouterRes.ok) {
      const errData: any = await openrouterRes.json().catch(() => ({}));
      const message = errData?.error || `OpenRouter error ${openrouterRes.status}`;
      return res.status(500).json({ error: message });
    }

    const openrouterData: any = await openrouterRes.json();
    const rawText = openrouterData.choices?.[0]?.message?.content;

    if (!rawText) {
      return res.status(200).json({ translation: 'No translation received' });
    }

    const textContent = typeof rawText === 'string'
      ? rawText
      : Array.isArray(rawText)
        ? rawText
            .map((chunk) => {
              if (typeof chunk === 'string') return chunk;
              if (chunk && typeof chunk === 'object' && 'text' in chunk) {
                return typeof chunk.text === 'string' ? chunk.text : '';
              }
              return '';
            })
            .join('')
        : '';

    const cleaned = textContent
      .replace(/```(?:json)?/g, '')
      .replace(/```/g, '')
      .trim();

    let translation: string | undefined;

    // Preferred: strict JSON
    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed?.translation === 'string') {
        translation = parsed.translation;
      }
    } catch {
      // Ignore
    }

    if (!translation) {
      translation = extractTranslationValue(cleaned);
    }

    // Fallback: extract the first JSON object that contains "translation"
    if (!translation) {
      const match = cleaned.match(/\{[\s\S]*"translation"\s*:\s*[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (typeof parsed?.translation === 'string') {
            translation = parsed.translation;
          }
        } catch {
          // Ignore
        }
      }
    }

    if (translation) {
      return res.status(200).json({ translation: translation.trim() });
    }

    // Fallback: trả về text trực tiếp nếu không parse được JSON
    return res.status(200).json({ translation: cleaned });
  } catch (error) {
    console.error('Translation error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
