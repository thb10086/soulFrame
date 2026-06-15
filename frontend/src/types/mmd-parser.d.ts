declare module "mmd-parser" {
  export interface VmdMotion {
    boneName: string;
    frameNum: number;
    position: [number, number, number];
    rotation: [number, number, number, number];
    interpolation: number[];
  }
  export interface VmdData {
    metadata: { name: string; motionCount: number };
    motions: VmdMotion[];
    morphs: unknown[];
    cameras: unknown[];
  }
  export class Parser {
    /** leftToRight=true 时转换为 three.js 右手系 */
    parseVmd(buffer: ArrayBuffer, leftToRight?: boolean): VmdData;
    parsePmd(buffer: ArrayBuffer, leftToRight?: boolean): unknown;
    parsePmx(buffer: ArrayBuffer, leftToRight?: boolean): unknown;
  }
  export const CharsetEncoder: unknown;
}
