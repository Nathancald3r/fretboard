"""Autopilot: works through autopilot/tasks.md with Claude Code while you're away.

For each open task it:
  1. runs `claude -p` (headless, no prompts to click) with your goals, the task and the house rules,
  2. checks the work itself (the tests, plus the task's own check command),
  3. on a failure, hands the error back to the same Claude session (up to --retries times),
  4. has a cheaper model review the commit against the task, and fixes once if the review fails,
  5. marks the task done [x], waiting on you [?] (its question goes to autopilot/questions.md), or stuck [!].

Safety: never skips permissions. Claude runs in "auto" mode (risky actions are refused, not asked),
with hard bans on deleting, force-pushing, resetting and the like. One copy at a time (a lock file).
Create autopilot/STOP to stop after the current step. Spending is capped per task and per day.

  python tools/autopilot.py            # do the next open task
  python tools/autopilot.py --loop     # keep going until the list is done, the day's budget is spent, or STOP
  python tools/autopilot.py --status   # what's done, waiting and open
  python tools/autopilot.py --dry-run  # show the prompt for the next task, run nothing
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOX = ROOT / "autopilot"
TASKS, GOALS, QUESTIONS = BOX / "tasks.md", BOX / "goals.md", BOX / "questions.md"
LOG, STATE, LOCK, STOP, STATUS = BOX / "log.md", BOX / "state.json", BOX / ".lock", BOX / "STOP", BOX / "STATUS.md"

# What Claude may never do here, whatever it decides.
BANNED = [
    "Bash(rm -rf:*)", "Bash(rm -r:*)", "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git reset --hard:*)",
    "Bash(git clean:*)", "Bash(git checkout -- :*)", "Bash(git stash:*)", "Bash(git rebase:*)", "Bash(git branch -D:*)",
    "Bash(del /s:*)", "Bash(Remove-Item -Recurse:*)", "Bash(format:*)", "Bash(shutdown:*)", "Bash(reg :*)",
    "Bash(schtasks:*)", "Bash(curl * | sh:*)", "Bash(iwr * | iex:*)",
    "PowerShell(Remove-Item -Recurse*)", "PowerShell(Stop-Computer*)", "PowerShell(Restart-Computer*)",
    "PowerShell(Set-ExecutionPolicy*)", "PowerShell(*Invoke-Expression*)",
]
RESULT = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["done", "question", "blocked"]},
        "summary": {"type": "string", "description": "2-4 plain sentences: what changed and how it was checked"},
        "question": {"type": "string", "description": "status question: the one thing only the user can answer"},
        "commits": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["status", "summary"],
}
REVIEW = {
    "type": "object",
    "properties": {"pass": {"type": "boolean"}, "issues": {"type": "array", "items": {"type": "string"}}},
    "required": ["pass", "issues"],
}
def claude_exe():
    """The real claude.exe (npm's claude.CMD would pass our arguments through cmd.exe, which mangles | and quotes)."""
    import shutil
    found = shutil.which("claude")
    if found and found.lower().endswith(".cmd"):
        exe = Path(found).parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
        if exe.exists():
            return str(exe)
    return found or "claude"


TASK_RE = re.compile(r"^- \[( |x|\?|!)\] (.+?)(?:\s+\|\s*check:\s*(.+))?$")


def now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def log(text):
    BOX.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8", newline="\n") as f:
        f.write(f"- {now()} {text}\n")
    print(text, flush=True)


# ---------------------------------------------------------------- tasks and questions

def read_tasks():
    lines = TASKS.read_text(encoding="utf-8").splitlines()
    tasks = []
    for i, line in enumerate(lines):
        m = TASK_RE.match(line.strip())
        if m:
            tasks.append({"line": i, "mark": m[1], "text": m[2].strip(), "check": (m[3] or "").strip()})
    return lines, tasks


def set_mark(task, mark):
    lines, _ = read_tasks()
    lines[task["line"]] = re.sub(r"^(\s*- \[).(\])", rf"\g<1>{mark}\2", lines[task["line"]], count=1)
    TASKS.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def answers():
    """{task text: answer} from questions.md, for questions the user has answered."""
    if not QUESTIONS.exists():
        return {}
    got = {}
    for block in QUESTIONS.read_text(encoding="utf-8").split("\n## ")[1:]:
        head, _, body = block.partition("\n")
        m = re.search(r"^Answer:\s*(.+)", body, re.M | re.S)
        if m and m[1].strip():
            got[head.strip()] = m[1].strip()
    return got


def ask(task, question):
    BOX.mkdir(exist_ok=True)
    new = not QUESTIONS.exists()
    with QUESTIONS.open("a", encoding="utf-8", newline="\n") as f:
        if new:
            f.write("# Questions from the autopilot\n\nWrite your answer after `Answer:`. The task runs again on the next start.\n")
        f.write(f"\n## {task['text']}\n{now()}: {question}\n\nAnswer: \n")


def reopen_answered(tasks):
    got = answers()
    for t in tasks:
        if t["mark"] == "?" and t["text"] in got:
            set_mark(t, " ")


# ---------------------------------------------------------------- spending

def state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def spent_today():
    return state().get("spent", {}).get(dt.date.today().isoformat(), 0.0)


def add_spend(usd):
    s = state()
    day = dt.date.today().isoformat()
    s.setdefault("spent", {})[day] = round(s.get("spent", {}).get(day, 0.0) + (usd or 0.0), 4)
    STATE.write_text(json.dumps(s, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- running things

def claude(prompt, *, schema, budget, model=None, resume=None, review=False, timeout=3600):
    """One headless Claude Code run. Returns (structured result or {}, session id, cost)."""
    cmd = [claude_exe(), "-p", "--output-format", "json", "--json-schema", json.dumps(schema),
           "--max-budget-usd", f"{budget:.2f}", "--disallowedTools", *BANNED]
    if review:  # the reviewer only reads
        cmd += ["--permission-mode", "dontAsk", "--allowedTools", "Read", "Grep", "Glob",
                "Bash(git show:*)", "Bash(git diff:*)", "Bash(git log:*)"]
    else:
        cmd += ["--permission-mode", "auto"]
    if model:
        cmd += ["--model", model]
    if resume:
        cmd += ["--resume", resume]
    try:
        p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                           cwd=ROOT, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "blocked", "summary": f"Claude ran over {timeout // 60} minutes."}, resume, 0.0
    try:
        out = json.loads(p.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"status": "blocked", "summary": "Claude gave no result: " + (p.stderr or p.stdout)[-400:]}, resume, 0.0
    cost = float(out.get("total_cost_usd") or 0)
    add_spend(cost)
    res = out.get("structured_output")
    if not isinstance(res, dict):
        m = re.search(r"\{.*\}", str(out.get("result", "")), re.S)
        try:
            res = json.loads(m[0]) if m else {}
        except ValueError:
            res = {}
    if out.get("is_error") and not res:
        res = {"status": "blocked", "summary": f"Claude stopped: {out.get('subtype')} {str(out.get('result'))[:300]}"}
    return res, out.get("session_id") or resume, cost


def check(task):
    """Our own check of Claude's work: the test suite, then the task's own check. (ok, last lines of output)"""
    cmds = ["node scripts/test.mjs"] + ([task["check"]] if task["check"] else [])
    for c in cmds:
        p = subprocess.run(c, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           cwd=ROOT, timeout=1800)
        if p.returncode:
            return False, f"`{c}` failed (exit {p.returncode}):\n" + "\n".join((p.stdout + p.stderr).splitlines()[-60:])
    return True, ""


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, cwd=ROOT).stdout.strip()


# ---------------------------------------------------------------- one task

RULES = """You are working on this project unattended: the user is away from the computer.
- Do only this task. Follow CLAUDE.md (it is loaded) and the goals above.
- Read only the files you need; keep the change small. Spend tokens like they're yours.
- Check your own work before you finish: run `node scripts/test.mjs`{check}, and look at the result in the
  preview (the `fretboard` entry, port 8421) when the change shows on a page. Never touch port 8420.
- When it works, commit and push with `node scripts/ship.mjs -m "message" <only the files you changed>`.
- Long jobs (over ~2 minutes) only if the task asks; keep GPU at most 85% and CPU at most 60%.
- If you need something only the user can give (a decision, a sign-in, the phone plugged in, a file you
  can't find), stop and return status "question" with ONE short question. Never guess at those.
- If a tool is refused, don't fight it: find another safe way, or return "question".
- End with the structured result: status, a 2-4 sentence summary, the commit ids."""


def run_task(task, args):
    goals = GOALS.read_text(encoding="utf-8") if GOALS.exists() else ""
    answer = answers().get(task["text"])
    prompt = (f"# The user's goals\n{goals}\n\n# Your task\n{task['text']}\n"
              + (f"\nThe user answered your earlier question: {answer}\n" if answer else "")
              + "\n# Rules\n" + RULES.format(check=f" and `{task['check']}`" if task["check"] else ""))
    if args.dry_run:
        print(prompt)
        return "dry"
    head = git("rev-parse", "HEAD")
    log(f"Start: {task['text']}")
    res, sid, cost = claude(prompt, schema=RESULT, budget=args.task_budget, model=args.model)
    if "authenticate" in res.get("summary", ""):
        log("Claude Code isn't signed in: run `claude` once in a terminal and type /login. Stopping.")
        return "stop"
    why = ""
    for attempt in range(args.retries + 1):
        if STOP.exists():
            log("STOP file found: stopping.")
            return "stop"
        status = res.get("status", "blocked")
        if status == "question":
            ask(task, res.get("question") or res.get("summary", "?"))
            set_mark(task, "?")
            log(f"Waiting on you: {res.get('question')}")
            return "question"
        if status == "blocked" and attempt == args.retries:
            break
        ok, why = check(task) if status == "done" else (False, res.get("summary", ""))
        if ok and args.review and git("rev-parse", "HEAD") != head:
            rv, _, c2 = claude(f"Review the commits {head}..HEAD against this task. Read only what you need.\n"
                               f"Task: {task['text']}\nPass only if the change does the task, works, and breaks "
                               "nothing obvious (wrong files committed, debug code left, line endings flipped). "
                               "List concrete issues, not style.", schema=REVIEW, budget=0.5,
                               model=args.review_model, review=True, timeout=900)
            cost += c2
            if not rv.get("pass", True):
                ok, why = False, "A review of your commits found:\n- " + "\n- ".join(rv.get("issues", []))
        if ok:
            set_mark(task, "x")
            log(f"Done (${cost:.2f}): {res.get('summary', '')}")
            return "done"
        if attempt == args.retries or spent_today() >= args.day_budget:
            break
        log(f"Retry {attempt + 1}: {why.splitlines()[0] if why else 'not finished'}")
        res, sid, c = claude(f"The check of your work failed. Fix it, check again, then give the result.\n\n{why}",
                             schema=RESULT, budget=args.task_budget, model=args.model, resume=sid)
        cost += c
    set_mark(task, "!")
    ask(task, f"I couldn't finish this. Last problem: {why or res.get('summary', '')}"[:1500]
        + "\nAnswer with a hint, or 'skip'.")
    log(f"Stuck (${cost:.2f}): {res.get('summary', '')}")
    return "stuck"


# ---------------------------------------------------------------- status and main

def write_status():
    _, tasks = read_tasks()
    groups = {"x": "Done", "?": "Waiting on you (see questions.md)", "!": "Stuck (see questions.md)", " ": "Open"}
    lines = [f"# Autopilot status ({now()})", "", f"Spent today: ${spent_today():.2f}", ""]
    for mark, title in groups.items():
        items = [t["text"] for t in tasks if t["mark"] == mark]
        if items:
            lines += [f"## {title}", *[f"- {t}" for t in items], ""]
    STATUS.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return "\n".join(lines)


def lock():
    if LOCK.exists() and time.time() - LOCK.stat().st_mtime < 3 * 3600:
        sys.exit(f"Another autopilot is running (remove {LOCK} if not).")
    LOCK.write_text(str(os.getpid()))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--loop", action="store_true", help="keep going through the list")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--task-budget", type=float, default=3.0, help="USD cap per Claude run")
    ap.add_argument("--day-budget", type=float, default=15.0, help="USD cap per day, all runs")
    ap.add_argument("--model", default=None, help="worker model (default: your Claude Code default)")
    ap.add_argument("--review-model", default="sonnet")
    ap.add_argument("--no-review", dest="review", action="store_false")
    args = ap.parse_args()
    if not TASKS.exists():
        sys.exit(f"No task list: write {TASKS} (one '- [ ] task' per line).")
    if args.status:
        print(write_status())
        return
    if not args.dry_run:
        lock()
    try:
        while True:
            _, tasks = read_tasks()
            reopen_answered(tasks)
            _, tasks = read_tasks()
            todo = [t for t in tasks if t["mark"] == " "]
            if not todo:
                log("Nothing open in the task list.")
                break
            if spent_today() >= args.day_budget:
                log(f"Today's budget (${args.day_budget:.2f}) is spent: stopping.")
                break
            if STOP.exists():
                log("STOP file found: stopping.")
                break
            if run_task(todo[0], args) in ("dry", "stop") or not args.loop:
                break
    finally:
        if not args.dry_run:
            LOCK.unlink(missing_ok=True)
            write_status()


if __name__ == "__main__":
    main()
