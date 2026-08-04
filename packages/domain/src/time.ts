import { z } from "zod";

export type Tick = number;
export type Microseconds = number;

export const TickSchema = z.number().int().nonnegative();
export const MicrosecondsSchema = z.number().int().nonnegative();
export const PositiveMicrosecondsSchema = z.number().int().positive();
