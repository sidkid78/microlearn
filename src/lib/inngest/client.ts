import { Inngest } from "inngest";

export type VideoGenerationEventData = {
  videoId: string;
  topicId: string;
  professionSlug: string;
  topicTitle: string;
  category: string;
  difficultyLevel: number;
};

export type Events = {
  "pipeline/video.batch.trigger": { data: { scheduledDate: string } };
  "pipeline/video.generate": { data: VideoGenerationEventData };
  "pipeline/video.render.completed": {
    data: {
      videoId: string;
      renderId: string;
      outputUrl: string;
      thumbnailUrl: string;
    };
  };
};

export const inngest = new Inngest({
  id: "microlearn-pro-pipeline",
});
