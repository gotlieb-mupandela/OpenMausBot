import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// 4 minutes 50 seconds — under Render Free's 15-minute idle spin-down.
crons.interval("wake render", { seconds: 290 }, internal.keepalive.pingRender);

export default crons;
