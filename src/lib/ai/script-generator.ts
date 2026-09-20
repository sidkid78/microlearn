import { GoogleGenAI, Type, Schema } from "@google/genai";

export interface ScriptScene {
  sequence: number;
  start_second: number;
  end_second: number;
  spoken_text: string;
  on_screen_hook: string;
  visual_style: "code_snippet" | "metric_callout" | "framework_grid" | "warning_box";
  icon_keyword: string;
}

export interface VideoScriptOutput {
  title: string;
  target_duration_seconds: number;
  scenes: ScriptScene[];
  full_voiceover_script: string;
  color_palette: {
    primary: string;
    accent: string;
    background: string;
  };
}

function getGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable");
  }
  return new GoogleGenAI({ apiKey });
}

const videoScriptSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    target_duration_seconds: { type: Type.INTEGER, description: "Must be 60" },
    full_voiceover_script: {
      type: Type.STRING,
      description: "Complete voiceover text without scene markers, exactly 135-150 words.",
    },
    color_palette: {
      type: Type.OBJECT,
      properties: {
        primary: { type: Type.STRING, description: "Hex code (e.g. #3B82F6)" },
        accent: { type: Type.STRING, description: "Hex code (e.g. #F59E0B)" },
        background: { type: Type.STRING, description: "Hex code (e.g. #0F172A)" },
      },
      required: ["primary", "accent", "background"],
    },
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sequence: { type: Type.INTEGER },
          start_second: { type: Type.NUMBER },
          end_second: { type: Type.NUMBER },
          spoken_text: { type: Type.STRING },
          on_screen_hook: { type: Type.STRING, description: "Punchy 3-5 word screen title" },
          visual_style: {
            type: Type.STRING,
            enum: ["code_snippet", "metric_callout", "framework_grid", "warning_box"],
          },
          icon_keyword: { type: Type.STRING, description: "Lucide icon identifier" },
        },
        required: [
          "sequence",
          "start_second",
          "end_second",
          "spoken_text",
          "on_screen_hook",
          "visual_style",
          "icon_keyword",
        ],
      },
    },
  },
  required: ["title", "target_duration_seconds", "full_voiceover_script", "color_palette", "scenes"],
};

export async function generateInstructionalScript(params: {
  profession: string;
  topicTitle: string;
  category: string;
  difficulty: number;
}): Promise<VideoScriptOutput> {
  const ai = getGenAI();

  const systemInstruction = `
You are the Lead Curriculum Director and Short-Form Video Architect for MicroLearn Pro.
Your task is to write a high-velocity, high-retention 60-second micro-lesson for a solopreneur / specialist.
Audience: Elite busy professionals. No fluff, no rhetorical greetings ("Hey guys!"), zero filler.
Structure:
1. The Hook (0-3s): Disrupt conventional wisdom or state a costly failure mode.
2. The Friction (3-15s): The exact problem, bottleneck, or inefficiency.
3. The Tactical Framework (15-45s): Actionable, step-by-step formula or mental model.
4. The Leverage Point / Call to Action (45-60s): Immediate implementation step.

Total word count MUST remain between 135 and 150 words to guarantee a 60-second execution at 140 WPM.
Output strictly according to the provided JSON Schema.
`;

  const prompt = `Generate a 60-second instructional micro-video specification.
Profession: ${params.profession}
Category: ${params.category}
Topic: ${params.topicTitle}
Difficulty: ${params.difficulty}/5`;

  const response = await ai.models.generateContent({
    model: "gemini-3.7-flash",
    contents: prompt,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: videoScriptSchema,
      temperature: 0.2,
    },
  });

  if (!response.text) {
    throw new Error("No text output received from Gemini.");
  }

  return JSON.parse(response.text) as VideoScriptOutput;
}
