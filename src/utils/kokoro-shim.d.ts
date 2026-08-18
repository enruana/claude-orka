// Local module shim for `kokoro-js`. The package ships types at
// node_modules/kokoro-js/types/kokoro.d.ts but its exports map only
// resolves those under `moduleResolution: "nodenext" | "bundler"`,
// and Orka's tsconfig uses classic node resolution to keep the CLI
// esbuild bundle simple. This shim exposes just the surface `utils/
// kokoro.ts` touches — no functional change.

declare module 'kokoro-js' {
  export interface KokoroAudio {
    audio: Float32Array
    sampling_rate: number
    save(path: string): void
  }
  export class KokoroTTS {
    voices: Record<string, unknown>
    static from_pretrained(
      modelId: string,
      opts?: { dtype?: 'q4' | 'q8' | 'fp16' | 'fp32'; device?: 'cpu' | 'wasm' }
    ): Promise<KokoroTTS>
    generate(text: string, opts?: { voice?: string; speed?: number }): Promise<KokoroAudio>
  }
}
