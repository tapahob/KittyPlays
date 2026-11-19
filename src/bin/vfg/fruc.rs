use libloading::os::windows::{
    Library, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use std::ffi::c_void;
use std::ptr::{null_mut, NonNull};

use super::Result;

type Handle = *mut c_void;
type DevicePtr = u64;
type Status = i32;

// Windows x64 layouts from the Optical Flow SDK 5 NvOFFRUC interface.
#[repr(C)]
struct Create {
    width: u32,
    height: u32,
    device: Handle,
    resource_type: i32,
    surface_format: i32,
    cuda_resource_type: i32,
    reserved: [u32; 32],
}

#[repr(C)]
struct Register {
    resources: [Handle; 10],
    fence: Handle,
    count: u32,
}

#[repr(C)]
struct Unregister {
    resources: [Handle; 10],
    count: u32,
}

#[repr(C)]
struct Frame {
    resource: Handle,
    timestamp: f64,
    pitch: usize,
    repeated: *mut bool,
    reserved: [u32; 32],
}

#[repr(C)]
struct Input {
    frame: Frame,
    skip_warp: u32,
    sync: [u64; 2],
    reserved: [u32; 32],
}

#[repr(C)]
struct Output {
    frame: Frame,
    sync: [u64; 2],
    reserved: [u32; 32],
}

pub struct Api {
    _fruc: Library,
    _cuda: Library,
    create: unsafe extern "system" fn(*const Create, *mut Handle) -> Status,
    register: unsafe extern "system" fn(Handle, *const Register) -> Status,
    unregister: unsafe extern "system" fn(Handle, *const Unregister) -> Status,
    process: unsafe extern "system" fn(Handle, *const Input, *const Output) -> Status,
    destroy: unsafe extern "system" fn(Handle) -> Status,
    release_context: unsafe extern "system" fn(i32) -> Status,
    set_context: unsafe extern "system" fn(Handle) -> Status,
    alloc: unsafe extern "system" fn(*mut DevicePtr, usize) -> Status,
    free: unsafe extern "system" fn(DevicePtr) -> Status,
    upload: unsafe extern "system" fn(DevicePtr, *const u8, usize) -> Status,
    download: unsafe extern "system" fn(*mut u8, DevicePtr, usize) -> Status,
    device: i32,
}

fn check(status: Status, operation: &str) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} failed (status {status})").into())
    }
}

impl Api {
    pub fn load() -> Result<Self> {
        let exe = std::env::current_exe()?;
        let path = std::fs::read_to_string(exe.with_file_name("fruc-path.txt"))
            .map_err(|_| "Run setup-vfg.ps1 with -FrucBin to install NVIDIA NvOFFRUC")?;
        let root = std::path::absolute(path.trim())?;
        macro_rules! symbol {
            ($library:ident, $name:literal) => {
                *$library.get(concat!($name, "\0").as_bytes())?
            };
        }
        // Use only the configured SDK directory and Windows system directory for DLLs.
        unsafe {
            let cuda = Library::load_with_flags("nvcuda.dll", LOAD_LIBRARY_SEARCH_SYSTEM32)?;
            let fruc = Library::load_with_flags(
                root.join("NvOFFRUC.dll"),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )?;
            let init: unsafe extern "system" fn(u32) -> Status = symbol!(cuda, "cuInit");
            let get_device: unsafe extern "system" fn(*mut i32, i32) -> Status =
                symbol!(cuda, "cuDeviceGet");
            let retain: unsafe extern "system" fn(*mut Handle, i32) -> Status =
                symbol!(cuda, "cuDevicePrimaryCtxRetain");
            let mut api = Self {
                create: symbol!(fruc, "NvOFFRUCCreate"),
                register: symbol!(fruc, "NvOFFRUCRegisterResource"),
                unregister: symbol!(fruc, "NvOFFRUCUnregisterResource"),
                process: symbol!(fruc, "NvOFFRUCProcess"),
                destroy: symbol!(fruc, "NvOFFRUCDestroy"),
                release_context: symbol!(cuda, "cuDevicePrimaryCtxRelease_v2"),
                set_context: symbol!(cuda, "cuCtxSetCurrent"),
                alloc: symbol!(cuda, "cuMemAlloc_v2"),
                free: symbol!(cuda, "cuMemFree_v2"),
                upload: symbol!(cuda, "cuMemcpyHtoD_v2"),
                download: symbol!(cuda, "cuMemcpyDtoH_v2"),
                _fruc: fruc,
                _cuda: cuda,
                device: -1,
            };
            check(init(0), "Initialize CUDA")?;
            let mut device = 0;
            check(get_device(&mut device, 0), "Select NVIDIA GPU")?;
            let mut context = null_mut();
            check(retain(&mut context, device), "Retain CUDA context")?;
            api.device = device;
            check((api.set_context)(context), "Activate CUDA context")?;
            Ok(api)
        }
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        if self.device >= 0 {
            unsafe {
                (self.set_context)(null_mut());
                (self.release_context)(self.device);
            }
        }
    }
}

pub struct Effect<'a> {
    api: &'a Api,
    handle: Handle,
    // NvOFFRUC registers addresses of CUDA pointers, so their storage must stay put.
    buffers: Box<[DevicePtr; 3]>,
    registered: bool,
    size: (u32, u32),
    pixels: Vec<u8>,
    index: u32,
}

impl<'a> Effect<'a> {
    pub fn new(api: &'a Api, size: (u32, u32)) -> Result<Self> {
        let (width, height) = size;
        let bytes = (width * height * 4) as usize;
        let mut effect = Self {
            api,
            handle: null_mut(),
            buffers: Box::new([0; 3]),
            registered: false,
            size,
            pixels: vec![0; bytes],
            index: 0,
        };
        let create = Create {
            width,
            height,
            device: null_mut(),
            resource_type: 0,      // CUDA
            surface_format: 1,     // ARGB (BGRA bytes)
            cuda_resource_type: 0, // CUdeviceptr
            reserved: [0; 32],
        };
        unsafe {
            check(
                (api.create)(&create, &mut effect.handle),
                "Create NvOFFRUC effect",
            )?;
            for buffer in effect.buffers.iter_mut() {
                check((api.alloc)(buffer, bytes), "Allocate CUDA frame")?;
            }
            let register = Register {
                resources: effect.resources(),
                fence: null_mut(),
                count: effect.buffers.len() as u32,
            };
            check(
                (api.register)(effect.handle, &register),
                "Register NvOFFRUC frames",
            )?;
        }
        effect.registered = true;
        Ok(effect)
    }

    pub fn size(&self) -> (u32, u32) {
        self.size
    }

    pub fn gpu_bytes(&self) -> u64 {
        u64::from(self.size.0) * u64::from(self.size.1) * 4 * self.buffers.len() as u64
    }

    fn resources(&self) -> [Handle; 10] {
        let mut resources = [null_mut(); 10];
        for (resource, buffer) in resources.iter_mut().zip(self.buffers.iter()) {
            *resource = NonNull::from(buffer).cast().as_ptr();
        }
        resources
    }

    pub fn push(&mut self, rgba: &[u8], generate: bool) -> Result<Vec<u8>> {
        let bytes = rgba.len();
        let input_index = (self.index % 2) as usize;
        let generate = generate && self.index > 0;
        let timestamp = f64::from(self.index);
        let pitch = self.size.0 as usize * 4;
        let resources = self.resources();
        let mut repeated = false;
        let input = Input {
            frame: Frame {
                resource: resources[input_index],
                timestamp,
                pitch,
                repeated: null_mut(),
                reserved: [0; 32],
            },
            skip_warp: u32::from(!generate),
            sync: [0; 2],
            reserved: [0; 32],
        };
        let output = Output {
            frame: Frame {
                resource: resources[2],
                timestamp: if generate { timestamp - 0.5 } else { timestamp },
                pitch,
                repeated: &mut repeated,
                reserved: [0; 32],
            },
            sync: [0; 2],
            reserved: [0; 32],
        };
        for (bgra, &[r, g, b, a]) in self
            .pixels
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(rgba.as_chunks::<4>().0)
        {
            *bgra = [b, g, r, a];
        }
        unsafe {
            check(
                (self.api.upload)(self.buffers[input_index], self.pixels.as_ptr(), bytes),
                "Upload NvOFFRUC frame",
            )?;
            check(
                (self.api.process)(self.handle, &input, &output),
                "Process NvOFFRUC frame",
            )?;
        }
        self.index += 1;
        if !generate {
            return Ok(Vec::new());
        }
        let mut rgba = vec![0; bytes];
        unsafe {
            check(
                (self.api.download)(rgba.as_mut_ptr(), self.buffers[2], bytes),
                "Download NvOFFRUC frame",
            )?;
        }
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(rgba)
    }
}

impl Drop for Effect<'_> {
    fn drop(&mut self) {
        unsafe {
            if self.registered {
                let unregister = Unregister {
                    resources: self.resources(),
                    count: self.buffers.len() as u32,
                };
                (self.api.unregister)(self.handle, &unregister);
            }
            if !self.handle.is_null() {
                (self.api.destroy)(self.handle);
            }
            for &buffer in self.buffers.iter().filter(|&&buffer| buffer != 0) {
                (self.api.free)(buffer);
            }
        }
    }
}
