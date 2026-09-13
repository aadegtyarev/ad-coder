pub fn prefix(value: &str, max_chars: usize) -> String {
    value[..max_chars.min(value.len())].to_owned()
}
