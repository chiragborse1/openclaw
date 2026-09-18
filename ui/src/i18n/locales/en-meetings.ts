import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMeetings = {
  meetings: {
    emptyTitle: "Your meeting notes, together",
    docs: "Set up meeting transcripts",
    inProgress: "In progress",
    activeNotes:
      "Capture is in progress. Follow the Transcript tab for speech as it is saved. Notes appear here when available.",
    liveCapture: "Live capture",
    liveHint: "Updates automatically every 3 seconds.",
    liveRetrying: "Updates are delayed. Retrying automatically.",
    waitingForSpeech: "Waiting for speech…",
    noSpeech: "No speech captured",
    listLabel: "Meetings by day",
    newestFirst: "Newest first · grouped by meeting date",
    loadingMeetings: "Loading meetings…",
    loadingSummary: "Loading summary…",
    loadingTranscript: "Loading transcript…",
    summaryAfterMeeting: "A summary is saved automatically when the meeting ends.",
    summaryUnavailable: "No saved summary preview is available.",
    noResults: "No meetings match your search",
  },
} satisfies TranslationMap;

export const registerMeetingsEnglish = Object.assign(
  () => {
    Object.assign(en, enMeetings);
  },
  { catalog: enMeetings },
);
