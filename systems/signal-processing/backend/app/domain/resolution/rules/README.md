Placeholder. Once `strategy.py` (option-strategy leg selection) grows past
a trivial placeholder, put its rule configs/tables here instead of
hardcoding them in the module. horizon/instrument_type are no longer
resolved here at all - see `../pipeline.py`, they come from the signal's
Strategy (`signal-generation`).
