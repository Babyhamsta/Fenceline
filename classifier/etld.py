"""Registrable-domain (eTLD+1) extraction. Used to split train/test so a site's
subdomains never straddle the split (which would inflate accuracy)."""
import tldextract

_extract = tldextract.TLDExtract(suffix_list_urls=())  # offline, bundled snapshot


def etld1(url_or_host: str) -> str:
    ext = _extract(url_or_host)
    if not ext.domain or not ext.suffix:
        return ""
    return f"{ext.domain}.{ext.suffix}"
