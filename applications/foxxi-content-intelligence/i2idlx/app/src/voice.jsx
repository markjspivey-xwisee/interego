// Voice for Ask: say the question, hear the answer. The speech itself is the shared module at
// applications/_shared/voice/ (the same file the coached world serves), bundled in from there, so
// there is one implementation and this file only joins it to the page. Recognition and synthesis
// are the browser's own; nothing here calls a model or sends audio anywhere.
import { createVoice, plainForSpeech } from "../../../../_shared/voice/voice.js";
import { byId } from "./data.js";

const { useState, useRef, useEffect, useCallback } = React;

const CITE = /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;
/** A sentence as it is shown: a [[concept-id]] citation is read as that term's label. */
export const spokenText = (sentence) => plainForSpeech(String(sentence).replace(CITE, (_, id, text) => text || (byId.get(id) ? byId.get(id).l : "")));

/**
 * turns, working   the conversation and whether an answer is still arriving
 * onInterim(text)  words still being recognized (shown in the question box)
 * onQuestion(text) a finished spoken question
 */
export function useAskVoice({ turns, working, onInterim, onQuestion }) {
  const [state, setState] = useState("idle");
  const [note, setNote] = useState("");
  // Not stored: reading aloud begins with a press on this visit, never by itself on load.
  const [reading, setReading] = useState(false);
  const handlers = useRef(null);
  handlers.current = { onInterim, onQuestion };
  const made = useRef(null);
  if (!made.current) {
    made.current = createVoice({
      prepare: spokenText,
      onState: setState,
      onError: (error) => setNote(error.message),
      onInterim: (text) => handlers.current.onInterim(text),
      onFinal: (text) => handlers.current.onQuestion(text),
    });
  }
  const voice = made.current;
  useEffect(() => () => voice.dispose(), [voice]);

  // Read answers that begin after reading was turned on, sentence by sentence as they stream.
  const from = useRef(0), following = useRef(-1);
  useEffect(() => {
    if (turns.length < from.current) from.current = 0;
    // The answer being read is gone (a new conversation, another source, an expired course):
    // stop reading it, so nothing that left the screen is still heard.
    if (following.current >= turns.length) { following.current = -1; voice.stop(); voice.resetDelta(); }
    if (!reading) return;
    const index = turns.length - 1, last = turns[index];
    if (!last || last.role !== "assistant" || index < from.current || !last.content) return;
    if (following.current !== index) { following.current = index; voice.resetDelta(); }
    voice.speakDelta(last.content);
    if (!working && !last.pending) voice.finishDelta();
  }, [turns, working, reading, voice]);

  const toggleReading = useCallback(() => {
    setNote("");
    if (reading) { voice.stop(); setReading(false); return; }
    from.current = turns.length; following.current = -1;
    setReading(true);
  }, [reading, turns.length, voice]);
  // The only place the microphone is opened: this press. Starting to listen stops the reading.
  const toggleListening = useCallback(() => {
    setNote("");
    if (voice.state === "listening" || voice.listeningRequested) voice.stopListening(); else voice.startListening();
  }, [voice]);
  const stopReading = useCallback(() => voice.stop(), [voice]);

  return { supported: voice.supported, notice: voice.notice, state, note, reading, listening: state === "listening", toggleReading, toggleListening, stopReading };
}
