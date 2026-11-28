# Shared by the deployment stand-ins, which source it through STANDIN_SOURCE.
#
# Environment: STANDIN_ROOT (every path stays below it), STANDIN_JOURNAL (append-only,
# tab-separated records), STANDIN_ROLE (root, service or operator; root when unset),
# STANDIN_HOME (service home), STANDIN_PATH (fixture bin directory), STANDIN_NODE (approved Node).
# Sibling stand-ins shadow system tools on PATH, so real tools are called by absolute path.

standin_role=${STANDIN_ROLE:-root}
# mawk starts about twice as fast as gawk; each chown and chmod runs one awk.
standin_awk=/usr/bin/awk
if [ -x /usr/bin/mawk ]; then standin_awk=/usr/bin/mawk; fi
standin_newline='
'

standin_fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Appends "call <name> <args...>". Multi-line arguments (inline scripts) are elided.
standin_call() {
  {
    printf 'call'
    for standin_argument do
      case $standin_argument in
        *"$standin_newline"*) standin_argument='<multiline>' ;;
      esac
      printf '\t%s' "$standin_argument"
    done
    printf '\n'
  } >>"$STANDIN_JOURNAL"
}

# Sets "resolved" to the lexically normalized absolute path, or refuses a path outside the fixture.
standin_inside() {
  case $1 in
    /*) resolved=$1 ;;
    *) resolved=$PWD/$1 ;;
  esac
  case $resolved in
    */. | */./* | */.. | */../* | *//*) resolved=$(/usr/bin/realpath -ms -- "$resolved") ;;
  esac
  case $resolved in
    "$STANDIN_ROOT" | "$STANDIN_ROOT"/*) ;;
    *) standin_fail "OUTSIDE FIXTURE: $resolved" ;;
  esac
}

# Like the kernel, refuses an ownership or mode change on an immutable target (or descendant, when
# recursive). Given a record kind and value, then appends "<kind> <value> <path>" for each target.
standin_change() {
  standin_recursive=$1 standin_kind=$2 standin_value=$3
  shift 3
  "$standin_awk" -F '\t' -v recursive="$standin_recursive" -v kind="$standin_kind" \
    -v value="$standin_value" -v journal="$STANDIN_JOURNAL" '
    BEGIN { for (i = 2; i < ARGC; i++) { targets[i] = ARGV[i]; delete ARGV[i] } }
    $1 == "chattr" { if ($2 == "+i") locked[$3] = 1; else delete locked[$3] }
    $1 == "create" { delete locked[$4] }
    END {
      for (path in locked)
        for (i in targets)
          if ((path == targets[i] || (recursive && index(path, targets[i] "/") == 1)) &&
            exists(path)) {
            print "IMMUTABLE OWNERSHIP/MODE TARGET: " path >"/dev/stderr"
            exit 1
          }
      if (kind != "") for (i in targets) print kind "\t" value "\t" targets[i] >>journal
    }
    function exists(path) {
      gsub(/\047/, "\047\\\047\047", path)
      return system("test -e \047" path "\047 || test -L \047" path "\047") == 0
    }
  ' "$STANDIN_JOURNAL" "$@"
}
