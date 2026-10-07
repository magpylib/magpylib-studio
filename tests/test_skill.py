"""The agent skill: where it lives, that it keeps the Agent Skills format, that
every example in it runs, and that its reference is what the code says today.

A skill is read as authoritative, so a claim in it that the code no longer
makes is worse than no skill (`docs/fem.md` §13.1). These are the checks that
keep it current: its examples are executed, top to bottom, as an agent would
copy them, and its reference is regenerated and compared. That it ships in the
wheel is `tools/check-package-alone.py`'s to check, on the built wheel.
"""

import pathlib
import re
import runpy

import magpylib_studio

ROOT = pathlib.Path(__file__).resolve().parents[1]
SKILL = (
    pathlib.Path(magpylib_studio.__file__).parent
    / ".agents"
    / "skills"
    / "magpylib-studio"
)


def _text():
    return (SKILL / "SKILL.md").read_text(encoding="utf-8")


def _frontmatter(text):
    """The frontmatter's fields, without a YAML parser: one line each, or a
    folded block (`>-`) of indented lines."""
    assert text.startswith("---\n"), "SKILL.md opens with its frontmatter"
    block = text.split("---\n", 2)[1]
    fields, key = {}, None
    for line in block.splitlines():
        if match := re.match(r"^([a-z][\w-]*):\s*(.*)$", line):
            key, value = match.groups()
            fields[key] = [] if value in {">-", ">", "|", "|-"} else [value]
        elif key is not None and line.startswith("  "):
            fields[key].append(line.strip())
    return {key: " ".join(lines) for key, lines in fields.items()}


def test_the_skill_keeps_the_agent_skills_format():
    """https://agentskills.io: a name that is its folder's, lowercase words
    joined by hyphens, and a description of at most 1024 characters -- what an
    agent reads to decide whether to load the rest."""
    fields = _frontmatter(_text())
    assert fields["name"] == SKILL.name
    assert re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?", fields["name"])
    assert "--" not in fields["name"]
    assert 0 < len(fields["description"]) <= 1024
    # The format's advice: what is loaded whole stays short, and the detail
    # sits in files it links to.
    assert len(_text().splitlines()) < 500


def test_what_the_skill_links_to_is_there():
    targets = re.findall(r"\]\((?!https?://|#)([^)#]+)\)", _text())
    assert targets, "SKILL.md links to its reference"
    assert [t for t in targets if not (SKILL / t).is_file()] == []
    anchors = re.findall(r"\]\(#([^)]+)\)", _text())
    headings = {
        re.sub(r"[^\w\- ]", "", heading).strip().lower().replace(" ", "-")
        for heading in re.findall(r"^#+ (.+)$", _text(), re.MULTILINE)
    }
    assert [a for a in anchors if a not in headings] == []


def test_every_example_in_the_skill_runs(tmp_path, monkeypatch):
    """In order, in one namespace, as an agent would run them one after
    another, in a folder of its own: they save and read files."""
    monkeypatch.chdir(tmp_path)
    examples = re.findall(r"^```python\n(.*?)^```$", _text(), re.DOTALL | re.MULTILINE)
    assert len(examples) >= 4
    namespace = {"__name__": "__main__"}
    for number, example in enumerate(examples, 1):
        code = compile(example, f"SKILL.md, example {number}", "exec")
        exec(code, namespace)  # noqa: S102 - the skill's own examples
    assert (tmp_path / "halbach.magpy.json").is_file()
    assert "duplicate_around" in (tmp_path / "halbach_scene.py").read_text()


def test_the_reference_is_what_the_code_says():
    """Regenerate it with `python tools/write-skill-reference.py`."""
    writer = runpy.run_path(str(ROOT / "tools" / "write-skill-reference.py"))
    written = (SKILL / "references" / "api.md").read_text(encoding="utf-8")
    assert written == writer["reference"](), (
        "references/api.md is out of date: run python tools/write-skill-reference.py"
    )
