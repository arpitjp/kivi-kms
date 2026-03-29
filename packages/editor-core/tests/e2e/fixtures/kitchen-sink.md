# Kitchen Sink Document

This document exercises **every** supported Markdown syntax element for round-trip fidelity testing.

## Inline Formatting

Here is **bold text**, *italic text*, and ~~strikethrough text~~.
Here is `inline code` and a [link to example](https://example.com "Example Title").
Here is **bold with *nested italic* inside** and ***bold italic*** together.

## Headings

### Third Level

#### Fourth Level

##### Fifth Level

###### Sixth Level

## Paragraphs

This is the first paragraph. It has multiple sentences. Each sentence should be preserved exactly.

This is the second paragraph, separated by a blank line from the first.

This is the third paragraph.
It has a hard line break right above (two trailing spaces or backslash).

## Unordered Lists

- Item one
- Item two
- Item three
  - Nested item A
  - Nested item B
- Item four

## Ordered Lists

1. First item
2. Second item
3. Third item
   1. Nested ordered A
   2. Nested ordered B
4. Fourth item

## Mixed List Markers

* Star item one
* Star item two

+ Plus item one
+ Plus item two

- Dash item one
- Dash item two

## Task Lists

- [x] Completed task
- [ ] Incomplete task
- [x] Another completed task

## Blockquotes

> This is a blockquote.
> It spans multiple lines.

> Nested blockquote:
>
> > Inner blockquote

## Code Blocks

```javascript
function hello() {
  console.log("Hello, world!");
  return 42;
}
```

```python
def greet(name):
    print(f"Hello, {name}!")
```

```
Plain code block without language
```

## Tables

| Header 1 | Header 2 | Header 3 |
| --- | --- | --- |
| Cell 1 | Cell 2 | Cell 3 |
| Cell 4 | Cell 5 | Cell 6 |

## Links and Images

[Simple link](https://example.com)

![Alt text for image](https://example.com/image.png)

## Horizontal Rules

Above the rule

---

Below the rule

## HTML Blocks

<div class="custom">
  <p>HTML content</p>
</div>

## Final Paragraph

This is the **final** paragraph of the kitchen sink document.
