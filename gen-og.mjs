// Generate the 1200x630 OG card. Run: NODE_PATH=$(npm root -g) node gen-og.mjs
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');
const { massSVG } = require('./public/shared-visual.js');

const font = fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf');
const fontB = fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');

const mass = massSVG({ mass: 820, vitality: 0.95, isAlpha: true, scaleMax: 820, size: 440, uid: 'og', animate: false });
const massURI = 'data:image/svg+xml;base64,' + Buffer.from(mass).toString('base64');

const el = {
  type: 'div',
  props: {
    style: { width: '1200px', height: '630px', display: 'flex', background: '#05060a', color: '#e9eef7',
      fontFamily: 'Liberation Sans', padding: '70px', alignItems: 'center', justifyContent: 'space-between' },
    children: [
      { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', width: '620px' }, children: [
        { type: 'div', props: { style: { fontSize: '22px', letterSpacing: '6px', color: '#6ff2ff', fontWeight: 700, marginBottom: '18px' }, children: 'PROOF OF MASS' } },
        { type: 'div', props: { style: { fontSize: '76px', fontWeight: 700, lineHeight: 1.0, marginBottom: '8px' }, children: 'One agent.' } },
        { type: 'div', props: { style: { fontSize: '76px', fontWeight: 400, lineHeight: 1.0, color: '#95a0b4', marginBottom: '28px' }, children: 'One mass.' } },
        { type: 'div', props: { style: { fontSize: '26px', color: '#95a0b4', lineHeight: 1.35, width: '560px' }, children: "Pak's Merge, applied to agents. Incoming mass consolidates. Total mass is conserved; positions only ever fall." } },
        { type: 'div', props: { style: { fontSize: '17px', color: '#5a6478', marginTop: '34px', letterSpacing: '1px' }, children: 'Experimental research · not a financial product' } }
      ] } },
      { type: 'div', props: { style: { display: 'flex', width: '470px', height: '470px', alignItems: 'center', justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 50%, rgba(111,242,255,0.06), rgba(5,6,10,0) 70%)' }, children: [
        { type: 'img', props: { src: massURI, width: 440, height: 440 } }
      ] } }
    ]
  }
};

const svg = await satori(el, { width: 1200, height: 630, fonts: [
  { name: 'Liberation Sans', data: font, weight: 400, style: 'normal' },
  { name: 'Liberation Sans', data: fontB, weight: 700, style: 'normal' }
] });
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
fs.writeFileSync(path.join(__dirname, 'public', 'og.png'), png);
console.log('wrote public/og.png', png.length, 'bytes');
