import { z } from "zod";

export const ACTION_CHANNELS = [
  "ui",
  "ai",
  "system",
  "webhook",
  "sho-ai",
] as const;

export type ActionChannel = (typeof ACTION_CHANNELS)[number];

export const actionChannelSchema = z.enum(ACTION_CHANNELS);
