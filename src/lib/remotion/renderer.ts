import { renderMediaOnLambda, getRenderProgress } from "@remotion/lambda";
import type { WordAlignment } from "../ai/tts-alignment";
import type { ScriptScene } from "../ai/script-generator";

export interface RenderJobProps {
  videoId: string;
  audioUrl: string;
  scenes: ScriptScene[];
  words: WordAlignment[];
  colorPalette: {
    primary: string;
    accent: string;
    background: string;
  };
}

function getRemotionConfig() {
  const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_SERVE_URL;

  if (!functionName || !serveUrl) {
    throw new Error("Missing REMOTION_LAMBDA_FUNCTION_NAME or REMOTION_SERVE_URL environment variables");
  }

  return {
    functionName,
    serveUrl,
    region: (process.env.REMOTION_AWS_REGION || "us-east-1") as "us-east-1",
  };
}

export async function dispatchRemotionRender(
  props: RenderJobProps
): Promise<{ renderId: string; bucketName: string }> {
  const { functionName, serveUrl, region } = getRemotionConfig();

  const { renderId, bucketName } = await renderMediaOnLambda({
    region,
    functionName,
    serveUrl,
    composition: "MicroLearnVerticalMaster",
    inputProps: props as unknown as Record<string, unknown>,
    codec: "h264",
    imageFormat: "jpeg",
    maxRetries: 2,
    privacy: "public",
    frameRange: [0, 1799],
    timeoutInMilliseconds: 240000,
  });

  return { renderId, bucketName };
}

export async function pollRenderStatus(
  renderId: string,
  bucketName: string
): Promise<{ done: boolean; outputUrl?: string; error?: string }> {
  const { functionName, region } = getRemotionConfig();

  const progress = await getRenderProgress({
    renderId,
    bucketName,
    functionName,
    region,
  });

  if (progress.fatalErrorEncountered) {
    return {
      done: true,
      error: progress.errors[0]?.message || "Fatal rendering error",
    };
  }

  if (progress.done && progress.outputFile) {
    return { done: true, outputUrl: progress.outputFile };
  }

  return { done: false };
}
