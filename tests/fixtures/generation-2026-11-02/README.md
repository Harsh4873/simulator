# Frozen populated generation

These three JSON files are byte-for-byte copies of the public November 2, 2026 generation committed at d47329bb94a845a366f9123d5828187bf1cf064d. Scenario, sampler, fitting, DOM, and publication-mutation tests use this generation so daily refreshes (including empty slates) cannot change their inputs.

Do not refresh these fixtures with the daily data job. Live artifact contract checks separately read `public/data/`; builder tests use isolated temporary output directories.
