export interface WordAlignment {
  word: string;
  start: number;
  end: number;
}

export interface TTSResult {
  audioBuffer: ArrayBuffer;
  durationSeconds: number;
  words: WordAlignment[];
}

export async function synthesizeSpeechWithAlignment(
  text: string,
  voiceId: string = "21m00Tcm4TlvDq8ikWAM"
): Promise<TTSResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY environment variable");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.85,
        style: 0.15,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API returned ${response.status}: ${errorText}`);
  }

  const payload = (await response.json()) as {
    audio_base64: string;
    alignment: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
  };

  const binaryString = atob(payload.audio_base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const audioBuffer = bytes.buffer;

  const words: WordAlignment[] = [];
  let currentWord = "";
  let wordStart = 0;
  let wordEnd = 0;

  const { characters, character_start_times_seconds, character_end_times_seconds } = payload.alignment;

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    const start = character_start_times_seconds[i];
    const end = character_end_times_seconds[i];

    if (char === " " || char === "\n" || i === characters.length - 1) {
      if (i === characters.length - 1 && char !== " " && char !== "\n") {
        currentWord += char;
        wordEnd = end;
      }
      if (currentWord.trim().length > 0) {
        words.push({
          word: currentWord.trim(),
          start: wordStart,
          end: wordEnd,
        });
      }
      currentWord = "";
      wordStart = i + 1 < characters.length ? character_start_times_seconds[i + 1] : end;
    } else {
      if (currentWord.length === 0) {
        wordStart = start;
      }
      currentWord += char;
      wordEnd = end;
    }
  }

  const durationSeconds = words.length > 0 ? words[words.length - 1]?.end ?? 60.0 : 60.0;

  return {
    audioBuffer,
    durationSeconds,
    words,
  };
}
