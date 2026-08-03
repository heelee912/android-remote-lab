using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class CompanionRelayLauncher
{
    private const uint CreateSuspended = 0x00000004;
    private const uint DetachedProcess = 0x00000008;
    private const uint StartfUseShowWindow = 0x00000001;
    private const short SwHide = 0;
    private const uint Infinite = 0xffffffff;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;

    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static readonly string Script = Path.Combine(Root, "relay.js");
    private static readonly string LauncherLog = Path.Combine(Root, "launcher.log");

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string reserved;
        public string desktop;
        public string title;
        public uint x;
        public uint y;
        public uint xSize;
        public uint ySize;
        public uint xCountChars;
        public uint yCountChars;
        public uint fillAttribute;
        public uint flags;
        public short showWindow;
        public short reserved2;
        public IntPtr reserved2Pointer;
        public IntPtr standardInput;
        public IntPtr standardOutput;
        public IntPtr standardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr process;
        public IntPtr thread;
        public uint processId;
        public uint threadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long perProcessUserTimeLimit;
        public long perJobUserTimeLimit;
        public uint limitFlags;
        public UIntPtr minimumWorkingSetSize;
        public UIntPtr maximumWorkingSetSize;
        public uint activeProcessLimit;
        public UIntPtr affinity;
        public uint priorityClass;
        public uint schedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong readOperationCount;
        public ulong writeOperationCount;
        public ulong otherOperationCount;
        public ulong readTransferCount;
        public ulong writeTransferCount;
        public ulong otherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation basicLimitInformation;
        public IoCounters ioInfo;
        public UIntPtr processMemoryLimit;
        public UIntPtr jobMemoryLimit;
        public UIntPtr peakProcessMemoryUsed;
        public UIntPtr peakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length < 1)
        {
            Log("A config path argument is required.");
            return;
        }
        string config = Path.GetFullPath(args[0]);
        string node = args.Length > 1
            ? Path.GetFullPath(args[1])
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (!File.Exists(node) || !File.Exists(Script) || !File.Exists(config))
        {
            Log("Missing node, relay, or config file.");
            return;
        }
        IntPtr job = CreateKillOnCloseJob();
        while (true)
        {
            var startup = new StartupInfo
            {
                cb = (uint)Marshal.SizeOf(typeof(StartupInfo)),
                flags = StartfUseShowWindow,
                showWindow = SwHide
            };
            var command = new StringBuilder(
                Quote(node) + " " + Quote(Script) + " " + Quote(config));
            ProcessInformation child;
            if (CreateProcess(
                    node,
                    command,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CreateSuspended | DetachedProcess,
                    IntPtr.Zero,
                    Root,
                    ref startup,
                    out child))
            {
                if (!AssignProcessToJobObject(job, child.process))
                {
                    TerminateProcess(child.process, 1);
                }
                else
                {
                    ResumeThread(child.thread);
                    WaitForSingleObject(child.process, Infinite);
                }
                CloseHandle(child.thread);
                CloseHandle(child.process);
            }
            else
            {
                Log("CreateProcess failed with Win32 error " + Marshal.GetLastWin32Error());
            }
            Thread.Sleep(5000);
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("Unable to create relay job object");

        var limits = new JobObjectExtendedLimitInformation();
        limits.basicLimitInformation.limitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, buffer, (uint)size))
            {
                CloseHandle(job);
                throw new InvalidOperationException("Unable to configure relay job object");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(LauncherLog, DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine);
        }
        catch
        {
        }
    }
}
