"""What every test starts from."""

import pytest

from magpylib_studio import fieldlines


@pytest.fixture(autouse=True)
def _no_field_matrices_kept():
    """The field matrices of solved sheets are kept for the process
    (`fieldlines.MATRIX_MEMORY`): a test reads none another one built."""
    fieldlines._matrices.clear()
    fieldlines._last_read.clear()
    fieldlines._too_large.clear()
    yield
    fieldlines._matrices.clear()
    fieldlines._last_read.clear()
    fieldlines._too_large.clear()
