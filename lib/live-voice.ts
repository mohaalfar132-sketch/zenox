/**
 * Live conversation: the browser listens, sends what you said, speaks the reply,
 * then listens again — a hands-free loop with no recording step. Uses the Web
 * Speech API where it exists (Chrome, Edge, Android) and reports clearly where
 * it does not, instead of failing silently.
 */
export type LiveVoiceState = "idle" | "listening" | "thinking" | "speaking";

type RecognitionEvent = {
  resultIndex: number;
  results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } };
};

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionCtor = new () => RecognitionLike;

export function speechRecognitionCtor(scope: unknown = globalThis): RecognitionCtor | null {
  const target = scope as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | null;
  return target?.SpeechRecognition ?? target?.webkitSpeechRecognition ?? null;
}

export function liveVoiceSupported(scope: unknown = globalThis): boolean {
  return Boolean(speechRecognitionCtor(scope));
}

export type LiveConversationHandlers = {
  onState?: (state: LiveVoiceState) => void;
  onTranscript?: (text: string) => void;
  onReply: (text: string) => Promise<void>;
  onError?: (message: string) => void;
};

export type LiveConversation = { stop: () => void; isActive: () => boolean };

/**
 * Starts the loop. `onReply` must resolve when the spoken answer finished, so
 * the microphone reopens after the app stops talking instead of hearing itself.
 */
export function startLiveConversation(
  handlers: LiveConversationHandlers,
  scope: unknown = globalThis,
): LiveConversation | null {
  const Ctor = speechRecognitionCtor(scope);
  if (!Ctor) return null;

  let active = true;
  let recognition: RecognitionLike | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (state: LiveVoiceState) => handlers.onState?.(state);

  const listen = () => {
    if (!active) return;
    const instance = new Ctor();
    recognition = instance;
    instance.lang = "ar-EG";
    instance.continuous = false;
    instance.interimResults = false;
    instance.onresult = (event) => {
      let text = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) text += result[0].transcript;
      }
      const spoken = text.trim();
      if (!spoken) return;
      handlers.onTranscript?.(spoken);
      setState("thinking");
      instance.stop();
      void handlers
        .onReply(spoken)
        .catch((error: unknown) => handlers.onError?.(error instanceof Error ? error.message : "تعذر إكمال الرد."))
        .finally(() => {
          if (!active) return;
          setState("listening");
          restartTimer = setTimeout(listen, 350);
        });
    };
    instance.onerror = (event) => {
      if (!active) return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        active = false;
        setState("idle");
        handlers.onError?.("اسمح باستخدام الميكروفون لبدء المحادثة الحية.");
        return;
      }
      if (event.error === "no-speech" || event.error === "aborted") return;
      handlers.onError?.(`تعذر التعرف على الصوت (${event.error ?? "خطأ"}).`);
    };
    instance.onend = () => {
      if (!active || restartTimer) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        listen();
      }, 400);
    };
    try {
      instance.start();
      setState("listening");
    } catch {
      // A second start before the previous session ended: retry shortly.
      restartTimer = setTimeout(() => {
        restartTimer = null;
        listen();
      }, 600);
    }
  };

  listen();

  return {
    isActive: () => active,
    stop: () => {
      active = false;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      try {
        recognition?.abort();
      } catch {
        // Already stopped.
      }
      setState("idle");
    },
  };
}
