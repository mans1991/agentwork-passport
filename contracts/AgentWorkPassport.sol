// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================
//  AgentWorkPassport — job board + escrow on-chain khusus
//  pemegang Binance Agent ID, dengan reputasi (Passport) yang
//  terikat ke identitas soulbound Agent ID itu sendiri.
//
//  Cara Agent ID dipakai (fungsi inti, bukan tempelan):
//   - registerPassport / createJob / acceptJob semuanya
//     mewajibkan balanceOf(registry) > 0 pada registry resmi
//     SPACE ID Agent ID (BSC).
//   - Reputasi menempel pada alamat pemegang Agent ID dan
//     tidak dapat dipindahkan (tidak ada token reputasi).
//
//  Izin owner (LENGKAP, tidak ada yang disembunyikan):
//   - setPaused: menghentikan registrasi & pembuatan job BARU.
//     Job yang sudah berjalan tetap bisa diselesaikan/direfund.
//   - transferOwnership / renounceOwnership standar Ownable.
//  Owner TIDAK bisa: menarik dana escrow, mengubah nilai job,
//  mengambil fee (fee platform = 0), membekukan dana user.
// ============================================================

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentRegistry {
    function balanceOf(address account) external view returns (uint256);
}

contract AgentWorkPassport is Ownable, ReentrancyGuard {
    // ---------- Konstanta ----------
    IAgentRegistry public immutable agentRegistry;
    uint256 public constant MIN_JOB_VALUE = 0.0001 ether; // nilai job minimum
    uint256 public constant REVIEW_WINDOW = 3 days;       // masa review setelah delivery
    uint64  public constant MAX_ACCEPT_WITHIN = 30 days;
    uint64  public constant MAX_DELIVER_WITHIN = 90 days;

    // ---------- Passport ----------
    struct Passport {
        bool registered;
        uint64 registeredAt;
        uint32 jobsPosted;     // sebagai client
        uint32 jobsCompleted;  // sebagai provider, selesai & dibayar
        uint32 jobsServed;     // sebagai client, selesai
        uint128 totalEarnedWei;
        uint128 totalSpentWei;
    }
    mapping(address => Passport) private _passports;
    uint256 public totalPassports;

    // ---------- Job ----------
    enum JobStatus { Open, Accepted, Delivered, Completed, Cancelled, Refunded }

    struct Job {
        address client;
        address provider;
        uint128 amount;
        uint64 createdAt;
        uint64 acceptBy;
        uint64 deliverBy;
        uint64 deliveredAt;
        JobStatus status;
        string metaURI;    // deskripsi job (tautan/URI off-chain)
        string deliverURI; // bukti hasil kerja (tautan/URI off-chain)
    }
    Job[] private _jobs;

    bool public paused;

    // ---------- Events ----------
    event PassportRegistered(address indexed agent);
    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount, string metaURI);
    event JobAccepted(uint256 indexed jobId);
    event JobDelivered(uint256 indexed jobId, string deliverURI);
    event JobCompleted(uint256 indexed jobId, address indexed provider, uint256 amount);
    event JobCancelled(uint256 indexed jobId);
    event JobRefunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event PausedChanged(bool paused);

    constructor(address agentRegistry_) Ownable(msg.sender) {
        require(agentRegistry_ != address(0), "registry 0");
        agentRegistry = IAgentRegistry(agentRegistry_);
    }

    // ---------- Gerbang Agent ID ----------
    function isAgent(address who) public view returns (bool) {
        return agentRegistry.balanceOf(who) > 0;
    }

    modifier onlyAgent() {
        require(isAgent(msg.sender), "bukan pemegang Agent ID");
        _;
    }

    // ---------- Passport ----------
    function _register(address who) internal {
        Passport storage p = _passports[who];
        if (p.registered) return;
        p.registered = true;
        p.registeredAt = uint64(block.timestamp);
        totalPassports += 1;
        emit PassportRegistered(who);
    }

    /// @notice Registrasi Passport. Gratis (hanya gas), 1x per alamat Agent ID.
    function registerPassport() external onlyAgent {
        require(!paused, "sedang dijeda");
        require(!_passports[msg.sender].registered, "sudah terdaftar");
        _register(msg.sender);
    }

    function passportOf(address who) external view returns (Passport memory) {
        return _passports[who];
    }

    /// @notice Level reputasi dari jumlah job selesai sebagai provider.
    function reputationLevel(address who) public view returns (uint8) {
        uint32 done = _passports[who].jobsCompleted;
        if (done >= 25) return 4;
        if (done >= 10) return 3;
        if (done >= 5) return 2;
        if (done >= 1) return 1;
        return 0;
    }

    // ---------- Job lifecycle ----------
    /// @notice Buat job & kunci BNB di escrow. Provider harus pemegang Agent ID.
    function createJob(
        address provider,
        string calldata metaURI,
        uint64 acceptWithin,
        uint64 deliverWithin
    ) external payable onlyAgent nonReentrant returns (uint256 jobId) {
        require(!paused, "sedang dijeda");
        require(provider != address(0) && provider != msg.sender, "provider tidak sah");
        require(isAgent(provider), "provider bukan pemegang Agent ID");
        require(msg.value >= MIN_JOB_VALUE, "nilai job di bawah minimum");
        require(bytes(metaURI).length > 0 && bytes(metaURI).length <= 512, "metaURI tidak sah");
        require(acceptWithin > 0 && acceptWithin <= MAX_ACCEPT_WITHIN, "acceptWithin tidak sah");
        require(deliverWithin > 0 && deliverWithin <= MAX_DELIVER_WITHIN, "deliverWithin tidak sah");

        _register(msg.sender);
        _register(provider);

        jobId = _jobs.length;
        uint64 now64 = uint64(block.timestamp);
        _jobs.push(Job({
            client: msg.sender,
            provider: provider,
            amount: uint128(msg.value),
            createdAt: now64,
            acceptBy: now64 + acceptWithin,
            deliverBy: now64 + acceptWithin + deliverWithin,
            deliveredAt: 0,
            status: JobStatus.Open,
            metaURI: metaURI,
            deliverURI: ""
        }));
        _passports[msg.sender].jobsPosted += 1;
        emit JobCreated(jobId, msg.sender, provider, msg.value, metaURI);
    }

    /// @notice Provider menerima job sebelum batas accept.
    function acceptJob(uint256 jobId) external onlyAgent nonReentrant {
        Job storage j = _job(jobId);
        require(msg.sender == j.provider, "bukan provider job ini");
        require(j.status == JobStatus.Open, "job tidak terbuka");
        require(block.timestamp <= j.acceptBy, "lewat batas accept");
        j.status = JobStatus.Accepted;
        emit JobAccepted(jobId);
    }

    /// @notice Provider menandai pekerjaan selesai & menyerahkan bukti.
    function deliverJob(uint256 jobId, string calldata deliverURI) external onlyAgent nonReentrant {
        Job storage j = _job(jobId);
        require(msg.sender == j.provider, "bukan provider job ini");
        require(j.status == JobStatus.Accepted, "job belum diterima");
        require(block.timestamp <= j.deliverBy, "lewat batas deliver");
        require(bytes(deliverURI).length > 0 && bytes(deliverURI).length <= 512, "deliverURI tidak sah");
        j.status = JobStatus.Delivered;
        j.deliveredAt = uint64(block.timestamp);
        j.deliverURI = deliverURI;
        emit JobDelivered(jobId, deliverURI);
    }

    /// @notice Client menyetujui hasil: dana escrow dilepas ke provider.
    function approveRelease(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        require(msg.sender == j.client, "bukan client job ini");
        require(j.status == JobStatus.Delivered, "job belum diserahkan");
        _complete(jobId, j);
    }

    /// @notice Provider mengklaim dana bila client diam selama masa review
    ///         setelah delivery. Aturan ini tertulis di kontrak & terlihat
    ///         oleh client sejak job dibuat.
    function claimAfterReview(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        require(msg.sender == j.provider, "bukan provider job ini");
        require(j.status == JobStatus.Delivered, "job belum diserahkan");
        require(block.timestamp > uint256(j.deliveredAt) + REVIEW_WINDOW, "masa review belum lewat");
        _complete(jobId, j);
    }

    function _complete(uint256 jobId, Job storage j) internal {
        j.status = JobStatus.Completed;
        Passport storage pp = _passports[j.provider];
        pp.jobsCompleted += 1;
        pp.totalEarnedWei += j.amount;
        Passport storage pc = _passports[j.client];
        pc.jobsServed += 1;
        pc.totalSpentWei += j.amount;
        emit JobCompleted(jobId, j.provider, j.amount);
        (bool ok, ) = j.provider.call{value: j.amount}("");
        require(ok, "pembayaran ke provider gagal");
    }

    /// @notice Client membatalkan job yang masih Open. Refund penuh.
    function cancelJob(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        require(msg.sender == j.client, "bukan client job ini");
        require(j.status == JobStatus.Open, "job sudah berjalan");
        j.status = JobStatus.Cancelled;
        emit JobCancelled(jobId);
        emit JobRefunded(jobId, j.client, j.amount);
        (bool ok, ) = j.client.call{value: j.amount}("");
        require(ok, "refund gagal");
    }

    /// @notice Refund job kedaluwarsa: Open lewat batas accept, atau
    ///         Accepted lewat batas deliver tanpa delivery.
    ///         Boleh dipicu siapa pun; dana HANYA kembali ke client.
    function refundExpired(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        bool expiredOpen = j.status == JobStatus.Open && block.timestamp > j.acceptBy;
        bool expiredWork = j.status == JobStatus.Accepted && block.timestamp > j.deliverBy;
        require(expiredOpen || expiredWork, "job belum kedaluwarsa");
        j.status = JobStatus.Refunded;
        emit JobRefunded(jobId, j.client, j.amount);
        (bool ok, ) = j.client.call{value: j.amount}("");
        require(ok, "refund gagal");
    }

    // ---------- Views ----------
    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    function _job(uint256 jobId) internal view returns (Job storage) {
        require(jobId < _jobs.length, "job tidak ada");
        return _jobs[jobId];
    }

    // ---------- Owner (terbatas, lihat header) ----------
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedChanged(paused_);
    }

    // Kontrak ini tidak menerima BNB di luar escrow job.
    receive() external payable {
        revert("gunakan createJob");
    }
}
