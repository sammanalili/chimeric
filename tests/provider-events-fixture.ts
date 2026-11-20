import {readFileSync} from 'node:fs';

/** Run the actual shared feed in the same VM realm as a component fixture. */
export const providerEventsPrelude=readFileSync(new URL('../src/provider-events.js',import.meta.url),'utf8').replace(/\bexport function /g,'function ');
