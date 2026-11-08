# PIXEL SPACE

PIXEL SPACE transforms a single 2D image into an interactive spatial pixel sculpture. The image is sampled into colored particles and assigned pseudo-depth based on brightness, local contrast, and edges, allowing users to explore it as a 2.5D/3D-like space.

Built as a university web programming project, it combines image interaction, gesture control, and generative sound in a browser-based experience.

## Features

- Upload a JPEG, PNG, or WebP image
- Built-in demo image
- Pixel-based spatial visualization
- Pseudo-depth generation
- Adjustable depth
- Adjustable pixel density
- Mouse / trackpad rotation and zoom
- Interactive pixel ripple and displacement
- Dynamic cosmic background
- Image-colored RGB debris and halo
- Color-based generative sound
- Hand tracking using MediaPipe Hand Landmarker
- Webcam hand-tracking preview and skeleton
- Hand gesture rotation
- Fast swipe with inertial spinning
- Pinch to grab and stop the object
- Fist-based interaction
- Two-hand zoom
- Pointing interaction with pixels and sound
- Hand-tracking confidence controls
- Responsive layout

## Interaction

Choose **TRY DEMO** to explore the built-in image, or **USE YOUR IMAGE** to upload an image. Use **DEPTH** and **DENSITY** to adjust the sculpture, **RESET** to restore its defaults, **NEW IMAGE** to replace the image, and **HOME** to return to the landing screen.

### Mouse / Trackpad

- **Drag:** rotate the pixel sculpture.
- **Scroll / trackpad scroll gesture:** zoom.
- **Move over the image:** interact with nearby pixels and trigger sound when enabled.

### Hand Control

Enable **HAND CONTROL** and allow camera access. The mirrored webcam preview shows detected landmarks and the current gesture.

- **Open-hand movement:** rotate the sculpture.
- **Fast swipe:** launch inertial rotation.
- **Pinch:** grab, precisely rotate, and stop spinning.
- **Fist:** brake; hold and move vertically to adjust depth or horizontally to preview density. Release to apply the density change.
- **Two hands:** spread or bring them together to zoom.
- **Pointing:** interact with pixels and color-based sound.

The preview includes Detection, Presence, and Tracking confidence sliders, plus **Sensitive**, **Balanced**, and **Strict** presets. Lower thresholds increase sensitivity and may also increase false detections. The preview can be collapsed.

## Sound

Enable **SOUND** to hear a soft piano / glass-like synthesized tone during pixel interaction. Pixel color influences the sound:

- **Hue** affects note selection.
- **Brightness** affects octave.
- **Saturation** influences timbre and intensity.

Sound starts muted and requires user interaction to activate.

## Technology

- HTML5 and CSS3 for structure, styling, and responsive layout
- Vanilla JavaScript for image processing and interaction
- WebGL for rendering the pixel sculpture
- Canvas 2D API for image sampling, backgrounds, and tracking overlays
- Web Audio API for synthesized sound
- MediaPipe Hand Landmarker for hand tracking
- Browser camera access through `getUserMedia`

The application is a static website with no build step or backend. It can be hosted on GitHub Pages.

## How to Run

From the project directory, start a local server:

```sh
python3 -m http.server 8002 --bind 127.0.0.1
```

Open [http://127.0.0.1:8002/](http://127.0.0.1:8002/) in a modern browser with WebGL support.

Hand Control requires a webcam, camera permission, and HTTPS or localhost. An internet connection is needed to load the MediaPipe runtime. The hand model is included in `assets/models/hand_landmarker.task`. Uploaded images and camera frames are processed locally in the browser.

## Testing

Run the logic regression checks:

```sh
node tests/check.cjs
node tests/hand-check.cjs
```

With the local server running, open:

- [Browser checks](http://127.0.0.1:8002/tests/browser.html) for image decoding, rendering, audio synthesis, and responsive layout.
- [Hand interaction checks](http://127.0.0.1:8002/tests/hand-studio.html) for preview, confidence controls, and gestures using synthetic inputs.

Synthetic gesture checks do not measure real-world tracking quality. Camera lighting, occlusion, and actual hand gestures should also be checked manually.

## Privacy

Uploaded images and webcam frames stay in the browser. The app does not upload them to a server. Camera access starts only when Hand Control is enabled. The MediaPipe runtime is downloaded from a CDN; the hand model is included locally.

## Notes

Depth is a visual effect estimated from image information, not measured geometry. Hand tracking works best with good lighting and visible hands. Browser camera permission and an internet connection for the tracking runtime are required for Hand Control.
