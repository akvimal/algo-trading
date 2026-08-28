class ResolutionError(Exception):
    """Raised when a signal can't be resolved - unknown/non-live strategy,
    or signal-generation unreachable. The caller persists the signal as a
    rejected resolved_order and does not publish to the Redis stream."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)
