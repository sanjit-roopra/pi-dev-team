# Writing style

Apply these rules when you write or change `README.md`, `CONTRIBUTING.md` or a file in `docs/`.

The rules join two sources. [SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) gives plain English after ASD-STE100, the controlled language of aircraft maintenance manuals. [i-have-adhd](https://github.com/ayghri/i-have-adhd) shapes text so that a reader with little working memory can act on it.

## Know which rules apply

| Text | Rules |
|---|---|
| `README.md`, `CONTRIBUTING.md`, `docs/*.md` | This file |
| Prompt files: `agents/`, `skills/`, `knowledge/`, `templates/`, `extensions/dev-team/gate/*.md`, `extensions/dev-team/lean/*.md` | Change only what you measured. See [Change a prompt file](../CONTRIBUTING.md#change-a-prompt-file). |
| Pull request titles and bodies, issues, comments | The `githubStyle` rules. See [Write docs, pull requests and issues](../CONTRIBUTING.md#write-docs-pull-requests-and-issues). |
| Lines in `CHANGELOG.md` | Each line is a pull request title or a commit subject, so the pull request rules apply. |

Do not apply this file to a prompt file. The model reads every word of a prompt file, and a style edit can move benchmark results.

## Shape the page

These rules come from i-have-adhd.

| Rule | What to do |
|---|---|
| Lead with the next action | A section that tells the reader to do something starts with that thing. Context comes after it, if at all. |
| Number every procedure | One bounded action per step. No step has "and then" two times. Use the fewest steps that work. |
| Keep lists short | Five items or fewer per list. If there are more, group them under sub-headings or in a table, most important first. Do not drop facts to meet the limit. |
| Give specific numbers | "52 checkpoints", "78.2% of hidden tests", "120 seconds". Never "a bit", "some" or "a lot". |
| Make results visible | Say what the reader gets: "Result: a pull request on your branch." |

More rules for the page:

- No preamble, no recap and no closing pleasantries. No "This document describes", no "In summary", no "Happy hacking".
- Each section must make sense when a reader lands in it from a link. Restate the state that the section needs. Link to the definition of a term instead of "as described above".
- One topic per section. A side topic goes into its own section or into a file in `docs/`, linked one time.
- For an error, state the symptom (quote the exact message), the cause and the fix. Use a matter-of-fact tone.

## Write the sentences

These rules come from the document rules of SimpleEnglish.

### Procedures and descriptions

- Procedural text tells the reader what to do. Use the imperative, at most 20 words per sentence and one instruction per sentence.
- Descriptive text tells how a thing works. Use simple tenses and at most 25 words per sentence. Write one topic per paragraph and at most six sentences per paragraph.
- Put the condition before the command, with a comma: "If the build fails, read the log."
- Put a warning command or condition first, then the risk: "Do not commit `.pi/dev-team/memory/`. It holds the requests that you typed."

### Grammar

- Use simple tenses and the active voice, and name the actor. No present perfect: "has completed" becomes "completed".
- No "-ing" clause after a comma: `, making it easy` becomes a new sentence.
- Use the modals `can`, `will` and `must`. Do not use `should`, `would`, `may`, `might` or `could`. A required `should` becomes `must`. Delete an optional one.
- Use complete grammar: no contractions, keep the articles, keep "that". Write short sentences, not telegraph style.
- Do not use semicolons or em-dashes (`—`). Write two sentences, or name the relation ("because", "but", "for example"). A hyphen or en-dash in a range or a compound word is correct.

### Words

- Use one word for one meaning in the whole file. Use "make sure that" for `check`, `verify`, `confirm` and `ensure` when it has that meaning. Use "configuration" for `config`, `settings` and `options` in prose. File names and keys stay as they are.
- Keep one term for each concept. For example, "agent" is never also "subagent", "persona" or "worker" for the same thing, unless the file defines the difference.
- Define each concept term at its first use, in fewer than ten words: "A guard hook (a script that runs around a tool call) can stop the call." Do not define product names or standard names (pi, Git, GitHub, JSON, Python).
- State the fact, not its importance. Delete `simply`, `just`, `easily`, `seamless`, `robust`, `powerful`, `comprehensive`, `leverage`, `crucial`, `in order to` and `it is worth noting`. No "not just X, it is Y". No decorative groups of three.
- Use American spelling.

### Facts

- Never change code, identifiers, commands, flags, file paths, quoted errors, product names, numbers or facts to fit a rule.
- If the source gives no number or cause, keep the general statement. Do not invent numbers.
- Take every number, path, command and flag from the code or the file that it describes.

### Formatting

- Use formatting only for structure. No bold lead-ins, no bold for emphasis, no emoji.
- Do not put a heading over fewer than two sentences of content.
- Use a vertical list only for three or more parallel items or steps. Put a colon on the lead-in, and start each item with an uppercase letter.

### Word swaps

| Instead of | Write |
|---|---|
| `leverage`, `utilize` | use |
| `in order to` | to |
| `prior to` | before |
| `ensure` | make sure that |
| `functionality` | function, feature |
| `enables you to` | you can |
| `facilitate` | help |
| `e.g.`, `i.e.` | for example, that is |
| `etc.` | the names of the items |
| `out of the box` | by default |
| `under the hood` | internally |
| `furthermore`, `moreover` | also |

## Make sure that a file follows the rules

Do these steps before you finish a file:

1. Find the banned strings with the command below. Fix each hit outside code spans and code blocks.

   ```bash
   grep -nE "—|\*\*|;|n't\b|'(re|ll|ve|d|m)\b|\b(should|may|might|could|would)\b|ha(s|ve|d) been|, [a-z]+ing\b|e\.g\.|i\.e\.|etc\." <file>
   ```

2. Count the words in the five longest sentences. Split a sentence over 25 words, or over 20 words in a step.
3. Count the items in each list. If a list has more than five, group it or make it a table.
4. Read each heading. Make sure that the section starts with what the reader does or gets.
5. Compare each number, path, command and flag with the source file or the code.

Result: a file that a reader can act on in one read. A file that is easy to read and wrong is worse than the old file, so step 5 is not optional.
