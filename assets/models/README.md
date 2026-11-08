# Hand Landmarker model

Preferred repository asset: `hand_landmarker.task` (MediaPipe Hand Landmarker FP16 bundle, version 1).

The model bundle is included in this repository. To download a fresh copy:

```sh
node scripts/download-hand-model.cjs
```

Official source: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

Model documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker

The app prefers this local asset and falls back to the same official versioned URL if the asset is absent. The build remains static. No camera frame is uploaded to either host.
