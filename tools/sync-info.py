#!/usr/bin/env python3
"""用 Makefile 里的字段同步 SPK 的 INFO（本地打包时用）。"""
import re
import sys


def field(text, name):
    m = re.search(r'^' + name + r'\s*=\s*"?(.*?)"?\s*$', text, re.M)
    return m.group(1) if m else ''


def main():
    mk, info, ver, md5 = sys.argv[1:5]
    mk_text = open(mk, encoding='utf-8').read()
    vals = {
        'version': ver,
        'checksum': md5,
        'description': field(mk_text, 'DESCRIPTION'),
        'displayname': field(mk_text, 'DISPLAY_NAME'),
        'maintainer': field(mk_text, 'MAINTAINER'),
        'maintainer_url': field(mk_text, 'MAINTAINER_URL'),
        'distributor': field(mk_text, 'DISTRIBUTOR'),
        'distributor_url': field(mk_text, 'DISTRIBUTOR_URL'),
        'helpurl': field(mk_text, 'HOMEPAGE'),
    }
    out = []
    for line in open(info, encoding='utf-8').read().splitlines():
        key = line.split('=', 1)[0]
        if key in vals and vals[key]:
            out.append('%s="%s"' % (key, vals[key].replace('"', '')))
        else:
            out.append(line)
    open(info, 'w', encoding='utf-8').write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main()
