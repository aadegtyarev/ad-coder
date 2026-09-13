def normalize_labels(values):
    return sorted({value.strip().casefold() for value in values if value.strip()})
