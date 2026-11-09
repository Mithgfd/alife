<p align="center">
  <img src="banner.svg" alt="ALIFE — evolving foragers">
</p>

<p align="center">
  <sub>A small artificial-life world in p5.js. Creatures carry a genome, run a tiny neural net, digest food into ATP and biomass, regulate genes through a heritable network, and develop from a single cell into a body built from four tissues. Food is the only primary resource; everything else is evolution finding a way to convert it into copies of itself.</sub>
</p>

<br>

<table align="center">
  <tr>
    <td align="center"><strong>14 – 496</strong><br><sub>population</sub></td>
    <td align="center">&nbsp;&nbsp;&nbsp;</td>
    <td align="center"><strong>88 – 270</strong><br><sub>generations</sub></td>
    <td align="center">&nbsp;&nbsp;&nbsp;</td>
    <td align="center"><strong>3 – 9</strong><br><sub>species</sub></td>
    <td align="center">&nbsp;&nbsp;&nbsp;</td>
    <td align="center"><strong>0</strong><br><sub>extinctions</sub></td>
    <td align="center">&nbsp;&nbsp;&nbsp;</td>
    <td align="center"><strong>0</strong><br><sub>pinned at cap</sub></td>
  </tr>
</table>

<p align="center"><sub>Ten seeded runs × 50k ticks on the shipped defaults. Reproduce with <code>SEEDS=1,2,3,4,5,6,7,8,9,10 TICKS=50000 node validate.js</code>.</sub></p>

---

## 01 — Quick start

```bash
open index.html        # macOS
xdg-open index.html    # Linux
```

No build step, no server, no install. `p5.min.js` is vendored, so it also works offline.

Every world has a seed. Open `index.html?seed=1234` to replay a specific run, or
press **share** to copy the current seed, speed, and toggles into the URL.

---

## 02 — The world

```text
alife/
  index.html   the page and toolbar
  sketch.js    p5 rendering + controls
  sim.js       headless simulation core (no p5, no DOM)
  p5.min.js    vendored, so it works offline
  test.js      one-run metrics
  repro.js     determinism, RNG isolation, save/load round-trip
  sweep.js     multi-seed parameter sweep
  validate.js  long-horizon check of the defaults
  smoke.js     headless browser smoke test (needs chromium)
```

---

## 03 — Controls

The toolbar exposes everything; the keys are shortcuts.

| Key | Action |
|:---:|:---|
| <kbd>space</kbd> | Pause / resume |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> | Speed presets (also a fine speed slider in the toolbar) |
| <kbd>r</kbd> | Reset with a fresh random world |
| <kbd>p</kbd> | Toggle predation |
| <kbd>c</kbd> | Colour by genes or by species |
| <kbd>s</kbd> | Toggle sexual / asexual reproduction |
| <kbd>d</kbd> | Download the whole world as JSON |
| <kbd>l</kbd> | Load a saved world |
| <kbd>catalog</kbd> | Open the species catalog: every species that ever existed, alive/extinct status, peak, lifespan, and trait profile |
| <kbd>click</kbd> | Inspect a creature: identity, ATP/nutrient/biomass, cells, tissues, development, realized vs. gene traits, regulation, behavior |

The panel on the right shows world totals, mean realised traits, a stacked
population graph split by species, and a detailed inspector for the selected
creature. The species catalog lists every species that has ever existed with its
status, lifespan, peak, and trait profile. Tissue fractions are drawn as four
coloured arcs around each body: gut, muscle, nerve, gonad.

Creature colour comes from its `hue` gene (neutral, so it drifts into lineages).
Brightness is current ATP relative to its reproduction threshold — starving
creatures dim out. Switch to **colour: species** to see the clustering instead.

### Shareable URLs

| Parameter | Meaning |
|:---|:---|
| `seed` | Reproduce a run exactly |
| `speed` | `1`–`128` simulation steps per frame |
| `color` | `species` to start in species colour mode |
| `sexual` | `0` or `1` to force reproduction mode |
| `predation` | `0` to disable predation |
| `paused` | `1` to load paused |

---

## 04 — The model

### Genome

Eleven structural scalars, a small regulatory genome, and 68 neural weights.

| Gene | Range | What it does |
|:---|:---:|:---|
| `size` | 0.55 – 2.10 | Adult body mass (`mass = size²`); sets the growth target |
| `speedMax` | 0.20 – 2.20 | Top speed, before regulation and muscle allocation |
| `sense` | 12 – 110 px | Perception radius, before regulation and nerve allocation |
| `hue` | 0 – 1 | Colour only, neutral |
| `mutRate` | 0.02 – 0.60 | Mutation step size for its own offspring |
| `reproE` | 20 – 80 | ATP needed to reproduce (scaled by mass) |
| `enzyme` | 0.25 – 2.00 | Digestive catalyst abundance |
| `allocGut` | 0.05 – 1.00 | Adult biomass allocation to gut tissue |
| `allocMuscle` | 0.05 – 1.00 | Adult biomass allocation to muscle tissue |
| `allocNerve` | 0.05 – 1.00 | Adult biomass allocation to nerve tissue |
| `allocGonad` | 0.05 – 1.00 | Adult biomass allocation to gonad tissue |
| `devTiming` | 0.30 – 0.90 | Maturity fraction at which the adult body plan takes over |

`mutRate` is itself a gene, so evolvability is heritable. The four `alloc`
loci are relative weights: they are normalised into tissue fractions that sum to
one, so only their ratios matter.

### Gene regulation

`size` and `hue` are expressed directly. The other five functional traits
(`speedMax`, `sense`, `mutRate`, `reproE`, `enzyme`) pass through a small
recurrent network before they become realised traits.

```text
6 inputs -> 4 regulatory proteins -> 5 promoters
```

The inputs are nutrient level, ATP level, maturity, local crowding, food
proximity, and age. Each regulator relaxes toward a tanh target every tick, and
each promoter maps the regulator state to an expression multiplier between
`0.5×` and `1.5×` of the structural gene. The network's weights, promoter
biases, and promoter sensitivities are part of the genome and mutate and
recombine like the scalar genes.

A neutral regulatory genome (all zeros) expresses each structural gene exactly,
which is also what older save files load as. Regulation is therefore an
evolvable layer on top of the original model, not a replacement for it.

### Development and growth

Offspring are born as a single cell and grow by division. Cell count rises from
one toward an adult count proportional to `targetMass / cellMass`.

Growth is also differentiation. New biomass is split across four tissues:

| Tissue | Realised effect |
|:---|:---|
| Gut | Digestion rate and gut capacity |
| Muscle | Top speed |
| Nerve | Perception radius |
| Gonad | Reproduction threshold |

The allocation program has two phases. Juveniles bias investment toward gut and
nerve, which keeps them alive while small. As maturity approaches `devTiming`,
the heritable adult allocation takes over. A gonad-heavy adult reproduces at a
lower energy threshold; a muscle-heavy adult is faster; a nerve-heavy adult
sees farther. Tissue fractions are displayed as coloured arcs around each body
and as numbers in the inspector.

Because tissue factors are relative to an even 25% allocation, a neutral body
plan leaves the old trait values unchanged. Development is a second evolvable
layer on top of regulation, not a hidden stat penalty.

### Brain

8 → 6 tanh → 2, fully connected.

Inputs are *egocentric* — forward/right relative to heading, not world x/y.

| # | Input | # | Input |
|:---:|:---|:---:|:---|
| 0 | Food forward | 4 | Creature right |
| 1 | Food right | 5 | ATP / threshold |
| 2 | Food proximity | 6 | Current speed / `speedMax` |
| 3 | Creature forward | 7 | Bias |

Outputs: `turn ∈ [−1, 1]`, `thrust ∈ [0, 1]`.

> Egocentric inputs matter. With world-frame `dx/dy` the network has no idea which
> way it is facing, so "steer toward food" is not a linear function it can learn.
> With forward/right it is one positive weight.

Generation 0 is not pure noise: each genome gets an innate, evolvable
foraging reflex (food-right → turn, food-ahead → thrust). Mutation can weaken,
invert, or rewire it like any other weight. Without it, random brains mostly
drift in circles and starve before reproducing, and the world never gets off the
ground.

### Metabolism

Food is **nutrient**, not usable energy. Eating adds up to 28 nutrient to the
gut, capped by `gutCap = (18 + 14 · size) · gutFactor`. Digestion is
Michaelis-Menten:

```text
flux = 5.0 · enzyme · nutrient / (nutrient + 12)
```

Each unit of digested nutrient yields `1.0` ATP and `0.03` biomass. Building
biomass costs `5.0` ATP per unit, so growth and reproduction draw on the same
ATP budget. ATP is also spent on basal metabolism:

```text
cost = 0.05 + 0.04·mass + 0.12·mass^0.75·speed²
```

Starvation burns biomass back into ATP at a lossy `3.0` ATP per biomass. A
creature with no ATP and no body left dies. Because storage is lossy, fat is
not a free energy multiplier.

The enzyme gene controls catalyst abundance, so digestive efficiency is
heritable. It is also regulated, which lets a creature up-regulate digestion
when the gut is full or ATP is low.

### Growth and reproduction

Offspring are born at 5% of adult mass and mature at 72%. Reaching adult size
requires both food and ATP, so a juvenile is a small, slow, conspicuous target.
Reproduction costs `0.52 × threshold`; the child receives
`0.42 × threshold`. The threshold is

```text
threshold = (30 + reproE · targetMass) · gonadFactor
```

The fixed term stops "be as small as possible" from being strictly optimal, and
`gonadFactor` lets a gonad-heavy body plan reproduce earlier.

### Sexual reproduction

On by default. A mature creature above `0.60 × threshold` looks for a compatible
mate within `mateRange` pixels. Both parents must be close enough in the six
functional genes (`mateRadius`), and each pays **half** the reproduction cost,
so two-parent reproduction costs the same total energy as one-parent
reproduction. The child inherits each scalar gene, each regulatory parameter,
and each neural weight from one parent, occasionally averages values, then
mutates at the parents' mean realised `mutRate`.

The half-cost rule matters: charging each parent the full cost makes sex a 2×
tax, and the population collapses whenever mates are scarce. Press <kbd>s</kbd>
to compare the two modes.

### Species

Every 90 ticks the world clusters living creatures over six functional genes —
`size`, `speedMax`, `sense`, `mutRate`, `reproE`, `enzyme`. `hue` is deliberately
excluded because it is neutral and would split lineages every time colour
drifted. Developmental allocation is also excluded: body plans can diverge
inside a lineage without instantly creating a new species label.

Clusters keep their id and colour while they have members. This is a
visual/statistical lens, not something the creatures can sense: nothing in the
simulation reads a species label. It exists so you can watch lineages diverge,
compete, and go extinct.

### Predation

Any creature that touches one with less than `1/1.45` of its mass eats it,
gaining `0.5 × prey ATP + 12 × prey mass`. A predator handles at most one
prey per tick, so it cannot clear a whole shoal in a single step. Size is the
trait, so there is no gene "valley" to cross: being big pays immediately and
being small is immediately risky. Juveniles are especially vulnerable because
they start at 5% of adult mass.

### Food

Logistic regrowth toward a cap, mostly clustered around five slowly drifting
meadows. Patches create territories; uniform scatter does not. Each item is 28
nutrient and must be digested before it becomes ATP or biomass.

### Seed bank

If the population falls below 20, competent random genomes trickle in. This is
the difference between "an interesting crash" and "a dead world you have to
restart".

---

## 05 — Determinism and saves

Each `World` owns a seeded RNG. A seed fully determines the run, two worlds can
exist side by side without sharing randomness, and the simulation never calls
`Math.random`.

Saving writes the full state: seed, RNG position, tick, parameters, patches,
food, every creature's structural genes, regulatory genome and current
regulatory activity, neural weights, ATP, nutrient, biomass, and the species
table. Tissue fractions and cell count are derived from biomass and the genome,
so they are recomputed deterministically on load. Loading a save continues the
*same* run, not merely a similar one — `repro.js` checks that two worlds are
byte-identical 2,000 ticks after a save/load round-trip.

The save format is version 4. Versions 1–3 still load: missing regulatory and
developmental loci default to neutral, which preserves the old phenotype.

```bash
node repro.js
```

---

## 06 — Knobs worth turning

All in `DEFAULTS` at the top of `sim.js`.

| Param | Effect |
|:---|:---|
| `foodGrowth` | Carrying capacity. This is the main population dial. |
| `foodCap` | How much food can exist at once. |
| `foodEnergy` | Nutrient per meal; changes how cheap growth and reproduction are. |
| `maxPop` | Hard ceiling. If the population pins here, selection is neutral. |
| `predation` | Turn it off for a pure foraging world (everything shrinks). |
| `preySizeRatio` | How much bigger you must be to eat someone. |
| `preyMassGain` | Biomass reward for eating prey; lower = less predator boom. |
| `basal`, `moveCost` | Maintenance cost; higher = faster turnover, sparser world. |
| `thresholdBase` | Fixed reproduction cost; keeps small bodies from being free. |
| `digestRate`, `digestKm` | Digestion speed and half-saturation. Lower `digestKm` = faster processing. |
| `atpYield`, `biomassYield` | ATP and biomass per unit of nutrient. |
| `growthCost` | ATP per biomass built; growth versus reproduction trade-off. |
| `catabolism` | ATP recovered per biomass burned while starving. |
| `birthMassFrac`, `matureFrac` | How small offspring start and when they can reproduce. |
| `cellMass` | Biomass per cell; sets the adult cell count. |
| `regRelax` | How fast regulatory proteins relax toward their network target. |
| `patchBias` | 0 = uniform food, 1 = fully clustered. |
| `immigrationBelow` | Extinction insurance. |
| `sexual` | Default reproduction mode. |
| `mateRange`, `mateMinEnergy` | How far and how well-fed a mate must be. |
| `mateRadius` | Compatibility distance; lower = reproductively isolated species. |
| `speciesRadius` | Cluster tightness for species colouring. |
| `speciesInterval` | How often species are rebuilt. |

---

## 07 — Headless tools

The whole point of keeping `sim.js` free of p5 is that you can measure the
dynamics instead of squinting at the canvas.

```bash
node test.js 40000            # one run, prints population/extinction/oscillation
SEED=7 node test.js           # a different world
node repro.js                 # determinism, RNG isolation, save/load round-trip
node sweep.js                 # configs × seeds, prints a comparison table
node validate.js              # 5 seeds × 40k ticks on the shipped defaults
node smoke.js                 # loads the page in headless chromium, checks the UI
```

`test.js`, `repro.js`, `sweep.js`, and `validate.js` are seed-driven, so results
are reproducible. `smoke.js` needs `chromium` on `PATH`.

Pass criteria for `validate.js`: no run goes extinct, no run pins at `maxPop`,
and the population stays in a band instead of collapsing.

---

<br>

<p align="center"><sub>p5.js · vanilla JavaScript · no build · works offline</sub></p>
