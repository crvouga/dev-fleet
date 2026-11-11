# Read-only health probe that `dev-fleet net check` pipes to each host over SSH (`sh -s`).
# Prints key=value lines; works on macOS and Linux (including WSL).
if [ "$(uname)" = Darwin ]; then
  echo "ncpu=$(sysctl -n hw.ncpu)"
  echo "load=$(sysctl -n vm.loadavg | awk '{print $2}')"
  echo "memfree=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/percentage/{gsub("%","",$2); print $2}')"
  sysctl -n vm.swapusage | awk '{t=$3; u=$6; gsub("M","",t); gsub("M","",u); if (t>0) print "swap=" int(u*100/t); else print "swap=0"}'
else
  echo "ncpu=$(nproc)"
  echo "load=$(cut -d' ' -f1 /proc/loadavg)"
  awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} /SwapTotal/{st=$2} /SwapFree/{sf=$2} END{print "memfree=" int(a*100/t); if (st>0) print "swap=" int((st-sf)*100/st); else print "swap=0"}' /proc/meminfo
fi
echo "diskmb=$(df -Pk "$HOME" | awk 'NR==2{print int($4/1024)}')"
