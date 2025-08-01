#!/usr/bin/env node
/*
 * storyboard_tool.js
 *
 * This script orchestrates the conversion of free‑form research text into a
 * structured storyboard and accompanying assets for Remotion. It demonstrates
 * how to invoke the master prompt provided in the specification, call the
 * OpenAI chat completions API, extract the YAML/JSON payloads, validate
 * them, and generate a stub React file for Remotion.  It does **not** depend
 * on Remotion at runtime; rather, it prepares the assets needed for a
 * separate Remotion project.  You will need to install `js-yaml` if you
 * haven't already (`npm install js-yaml`) and set an `OPENAI_API_KEY`
 * environment variable for the OpenAI call to succeed.
 *
 * Usage:
 *   node storyboard_tool.js --input research.md --output ./out
 *
 * The script will:
 *   1. Read the contents of the input file as research text.
 *   2. Replace the placeholder in the master prompt with the research text.
 *   3. Send the prompt to the OpenAI API (model gpt‑4o by default) and
 *      retrieve a response containing YAML and JSON blocks.
 *   4. Parse and validate the YAML and JSON; ensure they are isomorphic and
 *      that the total duration equals the sum of slide durations.
 *   5. Write the YAML and JSON to `storyboard.yaml` and `storyboard.json` in
 *      the output directory.
 *   6. Create a stub `Video.tsx` file that consumes the JSON and lays out
 *      sequences using Remotion primitives.  Rendering individual elements
 *      is left as an exercise: each element type can be mapped to an
 *      appropriate React component with animations.
 *   7. Create empty placeholder MP3 files for voice‑over tracks in
 *      `public/voiceovers/`.  A real implementation should use a TTS
 *      service to generate audio files for each slide.
 *
 * Note that this script is a skeleton to get you started.  It does not
 * implement full error handling, audio generation or slide rendering.  Feel
 * free to adapt it to your own needs.
 */

const fs = require('fs');
const path = require('path');

// Attempt to require js-yaml for YAML parsing.  It is optional because
// the YAML block can be treated as opaque data if js-yaml isn't present.
let yaml;
try {
  yaml = require('js-yaml');
} catch (err) {
  console.warn('[storyboard_tool] js-yaml not found; YAML parsing will be disabled.');
  yaml = null;
}

/**
 * The master prompt from the specification.  When sending the research to
 * OpenAI, the substring "<<PASTE FULL RESEARCH TEXT HERE>>" will be
 * replaced with the actual research text read from the input file.  This
 * prompt instructs the model to produce both a YAML and a JSON block with
 * identical semantic content.
 */
const MASTER_PROMPT = [
  'You are “Storyboard‑AI”, a film director who outputs YAML‑based storyboards for Remotion.',
  'Input research (verbatim, multi‑thousand words) is delimited by <<<RESEARCH>>> … <<<END>>>.',
  'Tasks:',
  '',
  '1. **Narrative arc** – Decide Act I (hook / problem), Act II (analysis / tension), Act III (resolution / call‑to‑action).',
  '2. **Slide breakdown** – Partition the story into numbered scenes (≈15‑45 sec each).',
  '3. **For every slide**, output:',
  "   • 'id' (kebab‑case), 'title', 'durationSec'.",
  "   • 'elements[]' ordered by on‑screen appearance. Each element:",
  "     ‑ 'kind' (heading | paragraph | bulletList | image | videoClip | chart | code | shape)",
  "     ‑ 'content' or 'src'",
  "     ‑ 'animationIn' / 'animationOut' (fade, wipe‑right, scale‑up, spring‑fly‑in, etc.)",
  "     ‑ 'startSec', optional 'endSec'.",
  "   • 'narration' – conversational, 1st‑person plural, ≤ 80 words.",
  "   • 'subtitles' – identical to narration or condensed captions.",
  "   • 'audioTracks': backgroundMusic (file name or “none”); sfx[] aligned to seconds.",
  "   • 'transitionToNext' – cut | cross‑fade | push‑left | custom.",
  "   • 'directorNotes' – free‑text with: pacing hints, visual mood, colour cues, relationship to previous/next slide, which element deserves emphasis, suggested FPS if divergent from default, volume ducking hints, mention “linger” or “skip quickly” as needed.",
  '',
  '4. Emit two artifacts with *identical* data:',
  "   a) 'storyboard.yaml' – easy for humans; b) 'storyboard.json' – camelCase keys for machines.",
  '',
  '5. After the YAML & JSON blocks, output an **exec summary table** listing slide id, title and durationSec to help editors spot timing at a glance.',
  '',
  'Remember: No Remotion code – just the data.',
  '',
  '<<<RESEARCH>>>',
  '<<PASTE FULL RESEARCH TEXT HERE>>',
  '<<<END>>>'
].join('\n');

/**
 * Parse command line arguments.  Only `--input` and `--output` are recognised.
 *
 * @returns {{input: string, output: string}}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  let input = null;
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' && i + 1 < argv.length) {
      input = argv[++i];
    } else if (arg === '--output' && i + 1 < argv.length) {
      output = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node storyboard_tool.js --input research.txt --output outDir');
      process.exit(0);
    }
  }
  if (!input) throw new Error('Missing --input argument');
  if (!output) throw new Error('Missing --output argument');
  return { input, output };
}

/**
 * Call the OpenAI chat completions API.  This function expects the
 * `OPENAI_API_KEY` environment variable to be set.  You can adjust the
 * `model`, `temperature`, or other fields as desired.  See
 * https://platform.openai.com/docs/api-reference/chat for details.
 *
 * @param {string} prompt The complete prompt to send to the model.
 * @returns {Promise<string>} The raw text of the response from the model.
 */
async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  // Node 18+ includes `fetch` globally.  If you are on an older version you
  // may need to install `node-fetch` and import it instead.
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} – ${text}`);
  }
  const json = await response.json();
  const message = json.choices[0].message;
  return message.content;
}

/**
 * Extract YAML and JSON blocks from the OpenAI response.  The model is
 * expected to delimit each block with triple backticks and the appropriate
 * language tag (`yaml` and `json`).  If the blocks cannot be found, an
 * error is thrown.
 *
 * @param {string} response The raw response from OpenAI.
 * @returns {{yaml: string, json: string, summary: string}}
 */
function extractBlocks(response) {
  const yamlMatch = response.match(/```yaml\n([\s\S]+?)```/);
  const jsonMatch = response.match(/```json\n([\s\S]+?)```/);
  if (!yamlMatch) {
    throw new Error('Unable to find YAML block in response');
  }
  if (!jsonMatch) {
    throw new Error('Unable to find JSON block in response');
  }
  // Optionally extract the exec summary table (not used by code but useful
  // for humans).  The table usually appears after the code blocks, but we
  // capture everything after the JSON fence as free text.
  const summary = response.slice(jsonMatch.index + jsonMatch[0].length).trim();
  return {
    yaml: yamlMatch[1].trim(),
    json: jsonMatch[1].trim(),
    summary,
  };
}

/**
 * Validate that the YAML and JSON representations are structurally
 * equivalent.  This function compares the parsed YAML (if parsing is
 * possible) against the JSON object; it also checks that the
 * `totalDurationSec` field in the metadata equals the sum of
 * `durationSec` over all slides.  Additional checks can be added here.
 *
 * @param {string} yamlStr The YAML text.
 * @param {string} jsonStr The JSON text.
 * @returns {{yamlObj: any, jsonObj: any}}
 */
function validateStoryboard(yamlStr, jsonStr) {
  let yamlObj = null;
  if (yaml) {
    try {
      yamlObj = yaml.load(yamlStr);
    } catch (err) {
      console.warn('[storyboard_tool] Failed to parse YAML:', err);
    }
  } else {
    console.warn('[storyboard_tool] YAML parsing disabled; skipping YAML structural check');
  }
  let jsonObj;
  try {
    jsonObj = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error('Invalid JSON returned by OpenAI: ' + err.message);
  }
  if (yamlObj) {
    // Deep comparison by serialising to JSON.  This is a simple check; for
    // complex YAML features (anchors, aliases) a more robust diff may be
    // required.
    const yamlAsJson = JSON.parse(JSON.stringify(yamlObj));
    const jsonCanonical = JSON.parse(JSON.stringify(jsonObj));
    if (JSON.stringify(yamlAsJson) !== JSON.stringify(jsonCanonical)) {
      console.warn('[storyboard_tool] Warning: YAML and JSON differ after normalisation.');
    }
  }
  // Validate durations
  if (jsonObj.meta && Array.isArray(jsonObj.slides)) {
    const total = jsonObj.slides.reduce((sum, s) => sum + (s.durationSec || 0), 0);
    if (jsonObj.meta.totalDurationSec && total !== jsonObj.meta.totalDurationSec) {
      console.warn(`[storyboard_tool] totalDurationSec (${jsonObj.meta.totalDurationSec}) does not match sum of slide durations (${total}).`);
    }
  }
  return { yamlObj, jsonObj };
}

/**
 * Generate a stub Remotion component file (`Video.tsx`) that consumes the
 * storyboard JSON.  The generated code defines a React component with a
 * single Composition whose duration equals the sum of slide durations.  A
 * Sequence is created for each slide.  Individual rendering of slide
 * elements is left as a TODO comment for the developer.
 *
 * @param {any} storyboard The parsed storyboard JSON.
 * @param {string} outDir The directory in which to write `Video.tsx`.
 */
function writeVideoTsx(storyboard, outDir) {
  const meta = storyboard.meta;
  if (!meta) {
    console.warn('[storyboard_tool] No meta field in storyboard; cannot generate Video.tsx');
    return;
  }
  const fps = meta.defaultFps || 30;
  const videoId = meta.videoId || 'generated-video';
  const width = meta.defaultResolution?.width || 1920;
  const height = meta.defaultResolution?.height || 1080;
  const totalFrames = (meta.totalDurationSec || 0) * fps;
  // Generate code
  let tsx = '';
  tsx += `import React from 'react';\n`;
  tsx += `import { Composition, Sequence, Audio, AbsoluteFill } from 'remotion';\n`;
  tsx += `import storyboard from './storyboard.json';\n\n`;
  tsx += `// This file was auto‑generated by storyboard_tool.js.\n`;
  tsx += `// It defines a Remotion Composition whose id is based on storyboard.meta.videoId.\n`;
  tsx += `// Each slide becomes a Sequence; rendering of individual elements is left as TODOs.\n\n`;
  tsx += `const Slide: React.FC<{ slide: any }> = ({ slide }) => {\n`;
  tsx += `  // TODO: Render slide elements here. You can map slide.elements to your own\n`;
  tsx += `  // custom components, apply animations based on startSec/endSec, and insert\n`;
  tsx += `  // Audio components for narration, backgroundMusic and sfx.\n`;
  tsx += `  return (\n`;
  tsx += `    <AbsoluteFill style={{ backgroundColor: 'white', color: 'black', justifyContent: 'center', alignItems: 'center' }}>\n`;
  tsx += `      {/* Example placeholder: show slide title centered on screen */}\n`;
  tsx += `      <h1>{slide.title}</h1>\n`;
  tsx += `    </AbsoluteFill>\n`;
  tsx += `  );\n`;
  tsx += `};\n\n`;
  tsx += `const MainVideo: React.FC = () => {\n`;
  tsx += `  let currentFrame = 0;\n`;
  tsx += `  const sequences = storyboard.slides.map((slide: any, index: number) => {\n`;
  tsx += `    const durationFrames = Math.round(slide.durationSec * storyboard.meta.defaultFps);\n`;
  tsx += `    const from = currentFrame;\n`;
  tsx += `    currentFrame += durationFrames;\n`;
  tsx += `    return (\n`;
  tsx += `      <Sequence key={slide.id} from={from} durationInFrames={durationFrames}>\n`;
  tsx += `        <Slide slide={slide} />\n`;
  tsx += `      </Sequence>\n`;
  tsx += `    );\n`;
  tsx += `  });\n`;
  tsx += `  return (\n`;
  tsx += `    <>\n`;
  tsx += `      {sequences}\n`;
  tsx += `    </>\n`;
  tsx += `  );\n`;
  tsx += `};\n\n`;
  tsx += `export const ${camelCase(videoId)}: React.FC = () => {\n`;
  tsx += `  return (\n`;
  tsx += `    <Composition\n`;
  tsx += `      id={storyboard.meta.videoId}\n`;
  tsx += `      component={MainVideo}\n`;
  tsx += `      durationInFrames={${totalFrames}}\n`;
  tsx += `      fps={${fps}}\n`;
  tsx += `      width={${width}}\n`;
  tsx += `      height={${height}}\n`;
  tsx += `    />\n`;
  tsx += `  );\n`;
  tsx += `};\n\n`;
  tsx += `export default ${camelCase(videoId)};\n`;
  // Write file
  const outPath = path.join(outDir, 'Video.tsx');
  fs.writeFileSync(outPath, tsx, 'utf8');
  console.log(`[storyboard_tool] Wrote Remotion component to ${outPath}`);
}

/**
 * Convert a string to camelCase.  This is used to generate a valid React
 * component name from the storyboard meta.videoId.  Non‑alphanumeric
 * characters are removed.
 *
 * @param {string} str
 * @returns {string}
 */
function camelCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[^a-zA-Z]*/, '')
    .replace(/^(.)/, (m) => m.toUpperCase());
}

/**
 * Create placeholder voice‑over files.  This function writes an empty MP3
 * file for each slide under the `public/voiceovers` folder.  In a
 * production implementation you should replace the body of this function
 * with calls to your TTS provider of choice.  Note that Remotion expects
 * audio files to live inside the `public` directory relative to your
 * project root.
 *
 * @param {any} storyboard
 * @param {string} outDir
 */
function createVoiceoverPlaceholders(storyboard, outDir) {
  const voiceDir = path.join(outDir, 'public', 'voiceovers');
  fs.mkdirSync(voiceDir, { recursive: true });
  storyboard.slides.forEach((slide) => {
    const filename = `${slide.id}.mp3`;
    const fullPath = path.join(voiceDir, filename);
    // Write zero bytes as a placeholder.  Most players will treat this as
    // invalid audio, but it makes it clear which files need to be replaced.
    fs.writeFileSync(fullPath, Buffer.alloc(0));
  });
  console.log(`[storyboard_tool] Wrote ${storyboard.slides.length} placeholder voice‑over files to ${voiceDir}`);
}

async function main() {
  const { input, output } = parseArgs();
  // Ensure output directory exists
  fs.mkdirSync(output, { recursive: true });
  // Read research text
  const research = fs.readFileSync(input, 'utf8');
  // Construct full prompt
  const prompt = MASTER_PROMPT.replace('<<PASTE FULL RESEARCH TEXT HERE>>', research);
  console.log('[storyboard_tool] Sending prompt to OpenAI...');
  const responseText = await callOpenAI(prompt);
  console.log('[storyboard_tool] Received response from OpenAI');
  const { yaml: yamlStr, json: jsonStr, summary } = extractBlocks(responseText);
  // Write raw YAML/JSON to files
  const yamlPath = path.join(output, 'storyboard.yaml');
  const jsonPath = path.join(output, 'storyboard.json');
  fs.writeFileSync(yamlPath, yamlStr);
  fs.writeFileSync(jsonPath, jsonStr);
  console.log(`[storyboard_tool] Wrote storyboard.yaml and storyboard.json to ${output}`);
  // Parse and validate
  const { jsonObj } = validateStoryboard(yamlStr, jsonStr);
  // Generate stub Video.tsx
  writeVideoTsx(jsonObj, output);
  // Create voice‑over placeholders
  createVoiceoverPlaceholders(jsonObj, output);
  // Write exec summary table as README.txt for convenience
  if (summary) {
    const summaryPath = path.join(output, 'EXEC_SUMMARY.txt');
    fs.writeFileSync(summaryPath, summary.trim());
    console.log(`[storyboard_tool] Wrote execution summary to ${summaryPath}`);
  }
  console.log('[storyboard_tool] Done.');
}

// Execute main if run directly
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
