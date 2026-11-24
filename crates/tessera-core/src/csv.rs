#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record<'a> {
    pub line: usize,
    pub raw: &'a str,
    pub fields: Vec<String>,
}

impl Record<'_> {
    pub fn is_blank(&self) -> bool {
        self.raw.trim().is_empty()
    }
}

pub struct Records<'a> {
    text: &'a str,
    delimiter: char,
    at: usize,
    line: usize,
    done: bool,
}

pub fn records(text: &str, delimiter: char) -> Records<'_> {
    Records {
        text: text.strip_prefix('\u{feff}').unwrap_or(text),
        delimiter,
        at: 0,
        line: 1,
        done: false,
    }
}

impl<'a> Iterator for Records<'a> {
    type Item = Record<'a>;

    fn next(&mut self) -> Option<Record<'a>> {
        if self.done {
            return None;
        }
        let start = self.at;
        let line = self.line;
        let rest = &self.text[start..];
        let mut fields = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        let mut end = rest.len();
        let mut chars = rest.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            match c {
                '"' if quoted && chars.peek().is_some_and(|(_, n)| *n == '"') => {
                    cur.push('"');
                    chars.next();
                }
                '"' => quoted = !quoted,
                '\n' if !quoted => {
                    end = i;
                    break;
                }
                '\n' => {
                    self.line += 1;
                    cur.push(c);
                }
                c if c == self.delimiter && !quoted => {
                    fields.push(std::mem::take(&mut cur).trim().to_owned());
                }
                _ => cur.push(c),
            }
        }
        fields.push(cur.trim().to_owned());
        if end == rest.len() {
            self.done = true;
        } else {
            self.at = start + end + 1;
            self.line += 1;
        }
        let raw = &rest[..end];
        Some(Record {
            line,
            raw: raw.strip_suffix('\r').unwrap_or(raw),
            fields,
        })
    }
}

pub fn sniff_delimiter(header: &str) -> char {
    let mut counts = [(',', 0usize), (';', 0), ('\t', 0), ('|', 0)];
    let mut quoted = false;
    for c in header.chars() {
        if c == '"' {
            quoted = !quoted;
        } else if !quoted && let Some(e) = counts.iter_mut().find(|(d, _)| *d == c) {
            e.1 += 1;
        }
    }
    counts
        .iter()
        .max_by_key(|(_, n)| *n)
        .filter(|(_, n)| *n > 0)
        .map_or(',', |(d, _)| *d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(text: &str) -> Vec<(usize, Vec<String>)> {
        records(text, ',').map(|r| (r.line, r.fields)).collect()
    }

    #[test]
    fn fields_split_trim_and_unquote() {
        let r = records(r#""a, b",c,"say ""hi""" "#, ',').next().unwrap();
        assert_eq!(r.fields, ["a, b", "c", r#"say "hi""#]);
        assert_eq!(records("a;b|c", ';').next().unwrap().fields, ["a", "b|c"]);
    }

    #[test]
    fn a_quoted_newline_stays_inside_its_field() {
        let text = "id,note,qty\r\n1,\"two\nlines\",3\r\n2,plain,4\r\n";
        assert_eq!(
            fields(text),
            [
                (1, vec!["id".into(), "note".into(), "qty".into()]),
                (2, vec!["1".into(), "two\nlines".into(), "3".into()]),
                (4, vec!["2".into(), "plain".into(), "4".into()]),
                (5, vec![String::new()]),
            ]
        );
    }

    #[test]
    fn records_number_their_first_line_and_keep_blank_ones() {
        let all: Vec<Record<'_>> = records("\u{feff}A,B\r\n\r\n1,2", ',').collect();
        assert_eq!(all.len(), 3);
        assert_eq!((all[0].line, all[0].raw), (1, "A,B"));
        assert!(all[1].is_blank());
        assert_eq!((all[2].line, all[2].raw), (3, "1,2"));
        assert_eq!(records("", ',').count(), 1);
    }

    #[test]
    fn the_delimiter_is_the_commonest_outside_quotes() {
        assert_eq!(sniff_delimiter("a;b;\"c,d,e\""), ';');
        assert_eq!(sniff_delimiter("a\tb\tc"), '\t');
        assert_eq!(sniff_delimiter("alone"), ',');
    }
}
