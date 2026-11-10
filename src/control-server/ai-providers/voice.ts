/** Speech-to-text a provider offers through its own login; the wiki Development page explains how to add one. */

/** Audio the browser sends: 16 kHz, mono, 16-bit little-endian PCM. */
export const VOICE_SAMPLE_RATE = 16000;

export interface VoiceOptions { language: string }

/** Callbacks of one voice connection; the control server forwards them to the browser. */
export interface VoiceHandlers {
  onReady(): void;
  /** Text heard so far; `final` closes a phrase, otherwise the text replaces the previous interim. */
  onTranscript(text: string, final: boolean): void;
  onError(message: string): void;
  /** The upstream connection ended; no more callbacks follow. */
  onClose(): void;
}

export interface VoiceConnection {
  /** Sends one chunk of PCM audio. */
  send(pcm: Buffer): void;
  /** Tells the provider the audio ended; its last transcripts still arrive before onClose. */
  finish(): void;
  /** Drops the connection without waiting for transcripts. */
  close(): void;
}

/** The speech service of one provider. */
export interface VoiceSource {
  open(context: { home: string; env: NodeJS.ProcessEnv; dir: string }, options: VoiceOptions, handlers: VoiceHandlers): Promise<VoiceConnection>;
}
