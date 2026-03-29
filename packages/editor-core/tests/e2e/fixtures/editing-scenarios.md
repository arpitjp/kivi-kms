# Editing Scenarios

This document tests that edits to individual blocks produce minimal diffs.

## Section One

This paragraph will be edited to add bold text.

## Section Two

This paragraph will remain completely untouched.

## Section Three

- List item alpha
- List item beta
- List item gamma

## Section Four

> A blockquote that will not change.

## Section Five

```typescript
const original = true;
const untouched = "this stays";
```

## Section Six

| Name | Value |
| --- | --- |
| Alice | 100 |
| Bob | 200 |

## Section Seven

This is the final section. It should remain byte-identical after edits above.
