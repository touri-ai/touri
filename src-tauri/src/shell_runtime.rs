use tokio::runtime::{Builder, Runtime};

pub fn get_runtime() -> std::io::Result<Runtime> {
    // The shell relays I/O; bot execution lives in the sidecar or on the server.
    Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("touri-async")
        .enable_all()
        .build()
}

#[cfg(test)]
mod tests {
    use super::get_runtime;
    use std::time::Duration;

    #[test]
    fn shell_workers_do_not_scale_with_the_machine_cpu_count() {
        let runtime = get_runtime().unwrap();

        assert_eq!(runtime.metrics().num_workers(), 2);
    }

    #[test]
    fn shell_runtime_drives_network_timers_and_blocking_work() {
        let runtime = get_runtime().unwrap();

        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let network =
                tokio::spawn(async move { tokio::net::TcpStream::connect(address).await.unwrap() });
            let timer = tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(1)).await;
                7
            });
            let blocking = tokio::task::spawn_blocking(|| 11);

            let _accepted = listener.accept().await.unwrap();
            let _connected = network.await.unwrap();

            assert_eq!(timer.await.unwrap() + blocking.await.unwrap(), 18);
        });
    }
}
