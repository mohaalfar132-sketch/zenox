import { describe, expect, it } from "vitest";
import { liveVoiceSupported, speechRecognitionCtor } from "../lib/live-voice";

describe("live conversation support", () => {
  it("finds the browser engine under either name", () => {
    class Fake {}
    expect(speechRecognitionCtor({ SpeechRecognition: Fake })).toBe(Fake);
    expect(speechRecognitionCtor({ webkitSpeechRecognition: Fake })).toBe(Fake);
    expect(liveVoiceSupported({ webkitSpeechRecognition: Fake })).toBe(true);
  });

  it("reports honestly when the browser has no speech engine", () => {
    expect(liveVoiceSupported({})).toBe(false);
    expect(liveVoiceSupported(null)).toBe(false);
    expect(speechRecognitionCtor(undefined)).toBeNull();
  });
});
