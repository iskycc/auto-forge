package control

// Java uses different console-encoding properties across supported JDK generations. Supplying
// both current and legacy names is harmless and keeps stdout/stderr UTF-8 from JDK 11 onward.
func javaUTF8Arguments() []string {
	return []string{
		"-Dfile.encoding=UTF-8",
		"-Dstdout.encoding=UTF-8",
		"-Dstderr.encoding=UTF-8",
		"-Dsun.stdout.encoding=UTF-8",
		"-Dsun.stderr.encoding=UTF-8",
	}
}
