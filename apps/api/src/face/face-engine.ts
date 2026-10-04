import { dirname, join } from 'node:path';
import { Logger } from '@nestjs/common';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The face software and its models, loaded on first use only (most servers never need it). */
export const FACE_MODEL = 'face-api 1.7 (SSD MobileNet v1, 68 landmarks, 128-d descriptor)';

type Descriptor = Float32Array;

/**
 * Finds faces and compares them, on this server, with open-source software (MIT licence): no
 * photo or face data is sent anywhere. One comparison at a time, so it never crowds out the rest
 * of On Par. Photos are only held in memory while being compared.
 */
export class FaceEngine {
  private static ready: Promise<{ tf: any; faceapi: any; sharp: any }> | null = null;
  private static queue: Promise<unknown> = Promise.resolve();
  private static readonly log = new Logger('Faces');

  private static load() {
    if (!this.ready) {
      this.ready = (async () => {
        const tf = require('@tensorflow/tfjs');
        const wasm = require('@tensorflow/tfjs-backend-wasm');
        const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
        const sharp = require('sharp');
        wasm.setWasmPaths(join(dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + '/');
        await tf.setBackend('wasm');
        await tf.ready();
        const models = join(dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(models);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(models);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(models);
        this.log.log('Face models loaded.');
        return { tf, faceapi, sharp };
      })();
      this.ready.catch(() => (this.ready = null));
    }
    return this.ready;
  }

  /** The largest face in a photo (turned upright first), or null if there is none, plus how many faces were seen. */
  private static async describe(photo: Buffer): Promise<{ descriptor: Descriptor | null; faces: number }> {
    const { tf, faceapi, sharp } = await this.load();
    const { data, info } = await sharp(photo)
      .rotate()
      .removeAlpha()
      .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const t = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    try {
      const found = await faceapi
        .detectAllFaces(t, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
      if (!found.length) return { descriptor: null, faces: 0 };
      const area = (f: any) => f.detection.box.width * f.detection.box.height;
      const biggest = found.reduce((a: any, b: any) => (area(b) > area(a) ? b : a));
      return { descriptor: biggest.descriptor, faces: found.length };
    } finally {
      t.dispose();
    }
  }

  /** Compares the main face in each photo. distance is null when either photo has no clear face. */
  static compare(a: Buffer, b: Buffer): Promise<{ distance: number | null; facesA: number; facesB: number }> {
    const run = async () => {
      const { faceapi } = await this.load();
      const [x, y] = [await this.describe(a), await this.describe(b)];
      const distance = x.descriptor && y.descriptor ? faceapi.euclideanDistance(x.descriptor, y.descriptor) : null;
      return { distance, facesA: x.faces, facesB: y.faces };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
