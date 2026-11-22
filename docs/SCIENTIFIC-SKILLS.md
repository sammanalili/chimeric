# Four generic scientific communication skills

The bundled pack contains four independently discoverable skills:

| Skill | Work it handles |
| --- | --- |
| `scientific-writing` | Scientific argument, narrative, captions, summaries and English/Japanese translation |
| `scientific-data-visualization` | Figure planning, measured charts, uncertainty and proportionate export review |
| `scientific-illustration` | Qualitative illustrations, editable diagrams and scientific annotation |
| `scientific-documents` | Reports, handouts and research presentations |

Each entrypoint is short and links only to its own focused references. The style
guide uses adjustable neutral colors and available licensed fonts. It does not
require a specific model, image service, renderer, private font or another skill.
The requested format and user's brief take priority over the defaults.

The pack was reauthored from reusable guidance. It includes no original example
figures, datasets, generated art, presentations, fonts, logs or provenance files.
There are no private project examples or personal filesystem paths. No reference
images are bundled; any future examples should be freshly made and synthetic.

The build accepts only these four skill directories and their reviewed Markdown
instructions/references. It refuses symlinks and extra datasets or binary assets.
Their contents are included in the frontend asset version so changes take effect
in a newly built package. The original supplied archive is not modified or shipped.

## Download version 1.0.0

Get the standalone pack from the [scientific skills 1.0.0 release](https://github.com/sammanalili/chimeric/releases/tag/scientific-skills-v1.0.0).
This skill-pack version is independent of the Chimeric app version.

Use the individual ZIPs for Chimeric's single-skill importer:

| Download | Contents |
| --- | --- |
| [scientific-writing.zip](https://github.com/sammanalili/chimeric/releases/download/scientific-skills-v1.0.0/scientific-writing.zip) | Writing and English/Japanese translation |
| [scientific-data-visualization.zip](https://github.com/sammanalili/chimeric/releases/download/scientific-skills-v1.0.0/scientific-data-visualization.zip) | Charts, figure planning and review |
| [scientific-illustration.zip](https://github.com/sammanalili/chimeric/releases/download/scientific-skills-v1.0.0/scientific-illustration.zip) | Illustrations, diagrams and annotation |
| [scientific-documents.zip](https://github.com/sammanalili/chimeric/releases/download/scientific-skills-v1.0.0/scientific-documents.zip) | Reports and research presentations |

The combined `chimeric-scientific-skills-1.0.0.zip` is for manual installation
in other skill-compatible agents. It contains the four skill folders, this guide
as `README.md`, and the Apache-2.0 `LICENSE`. Each skill folder contains `SKILL.md`
and its own `references` directory. Each individual ZIP contains one skill at
its root, plus `LICENSE`.

The downloads contain only text instructions and license files. They include no
app runtime, model weights, API keys, datasets or reference images.

## Install and use the skills

In Chimeric builds that bundle this pack, open **Settings → Skills** and search
for the skill names above. Use the existing entries when they are already listed.

If a skill is absent from your Chimeric installation:

1. Download its individual ZIP. Keep its filename unchanged so the importer uses
   the correct skill identifier.
2. In **Skills**, choose **Add skill → Upload a skill**, then select that ZIP.
3. Review the imported instructions and references. Choose **Save** or **Save
   draft**, depending on the account controls shown. Publishing to an account or
   organization is optional for local use.
4. Repeat for the other skills you need. The combined four-skill ZIP cannot be
   uploaded through the single-skill importer.

Bundled or Featured skills cannot be replaced through this upload flow. To keep
a customized local copy, give it a distinct skill identifier.

For another agent that supports `SKILL.md` skills:

1. Download and extract `chimeric-scientific-skills-1.0.0.zip`.
2. Copy the selected skill folders into that agent's configured skills directory.
   Keep each `references` directory next to its `SKILL.md`. Review an existing
   installation before replacing its files.
3. Follow that agent's skill reload instructions, then request a task by skill
   name or describe the work you need.

The pack provides instructions. The host agent supplies its models, file access,
rendering tools and any image-generation connection. Installing a skill does not
configure a provider or send data to a service.

Example requests:

- **Writing:** “Use scientific-writing to revise this abstract. Preserve every
  number and distinguish measured results from proposed explanations.”
- **Data visualization:** “Use scientific-data-visualization to plot this table
  with units and uncertainty. Save the code and an editable figure.”
- **Illustration:** “Use scientific-illustration to make a clean 2D schematic
  from these references. Keep labels and arrows editable.”
- **Documents:** “Use scientific-documents to turn these findings into a short
  research presentation with readable figures and speaker notes.”

## License and source

These four Chimeric skills are distributed under Apache License 2.0, included in
each download. Their source is in
[`resources/skills`](https://github.com/sammanalili/chimeric/tree/scientific-skills-v1.0.0/resources/skills).
Reused publications, images and datasets retain their own licenses.

The release includes `SHA256SUMS` for checking the downloaded archives. On macOS,
use `shasum -a 256 FILENAME`; on Linux, use `sha256sum FILENAME`; on Windows
PowerShell, use `Get-FileHash FILENAME -Algorithm SHA256`. Compare the result with
the entry for that filename in `SHA256SUMS`.
