from core.inference.ollama import think_param


def test_gpt_oss_no_puede_apagar_el_razonamiento():
    assert think_param("gpt-oss:120b", False) == "low"
    assert think_param("GPT-OSS:20b", False) == "low"
    assert think_param("gpt-oss:120b", True) == "medium"
    assert think_param("gpt-oss:120b", None) is None


def test_gpt_oss_respeta_niveles():
    assert think_param("gpt-oss:120b", "high") == "high"
    assert think_param("gpt-oss:120b", "low") == "low"


def test_otros_modelos_solo_entienden_booleanos():
    assert think_param("qwen3.5:27b", False) is False
    assert think_param("qwen3.5:27b", True) is True
    assert think_param("qwen3.5:27b", "high") is True
    assert think_param("", False) is False
