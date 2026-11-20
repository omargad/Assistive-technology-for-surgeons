"""``python -m surgeonpulse_analysis`` — same as the ``surgeonpulse`` console script."""

import sys

from .cli import main

sys.exit(main())
